import manifestRaw from "../../../../tools/codegen/generated/successor.commands.manifest.v1.json?raw";
import verbsRaw from "../../../../tools/codegen/generated/verbs.generated.json?raw";

import { actorRelationToPlayer, type ActorRelationSubject, type ActorRelationToPlayer } from "../actorRelationSystem";
import {
  authorityCommandKind,
  authorityIssuedAtServerTick,
  enqueueAuthorityCloneRespawnCommand,
  enqueueAuthorityCommand,
  enqueueAuthorityDeathblowCommand,
  enqueueAuthorityPeaceCommand,
  enqueueAuthorityProposeTradeCommand,
  enqueueAuthorityQueueCombatActionCommand,
  enqueueAuthoritySampleResourceCommand,
  enqueueAuthorityStopResourceSampleCommand,
  enqueueAuthoritySetPostureCommand,
  enqueueAuthoritySurveyResourceCommand,
  type AuthorityClientCommand,
  type CombatActionId,
  type AuthorityClientCommandEnvelope,
  type AuthorityClientCommandKind,
  type ExchangeTradeItem,
} from "../authorityCommandSystem";
import type {
  ActorSnapshot,
  InventoryRow,
  PlayState,
  ServerAuthorityActorState,
  SliceSnapshot,
} from "../gameState";
import { currentArea } from "../worldQueries";
import {
  clearInvisibleTargetSelection,
  resolveTargetSelector,
  setSelectedTarget,
  visibleTargetActors,
  type TargetSelectionResult,
} from "../targetSelectionSystem";
import {
  inventoryScopeForState,
  isInventorySurfaceRowInScope,
  type InventoryOwnerIdentity,
} from "../inventoryScope";
import { resourceTaxonomyEntries } from "../resourceTaxonomy";


/** Generated commands expose Rust enum spellings; packets use bridge wire ids. */
const authorityWireEnumByArg: Record<string, Record<string, string>> = {
  weapon_id: {
    Slugthrower: "slugthrower",
    Vibrosword: "vibrosword",
    WpnPistol: "wpn-pistol",
    WpnSmg: "wpn-smg",
    WpnCarbine: "wpn-carbine",
    WpnAssault: "wpn-assault",
    WpnShotgun: "wpn-shotgun",
    WpnSniper: "wpn-sniper",
    WpnHeavy: "wpn-heavy",
    WpnLauncher: "wpn-launcher",
  },
  ammo_type: {
    SlugIron: "slug_iron",
    SlugShard: "slug_shard",
    SlugSpike: "slug_spike",
    Melee: "melee",
  },
};
export type VerbClass = "authority" | "local" | "query";
export type VerbArgType = "int" | "milli" | "enum" | "id-domain" | "text";

export interface VerbArgSchema {
  name: string;
  type: VerbArgType;
  required: boolean;
  enumValues?: readonly string[];
  domain?: string;
  repeated?: boolean;
  nullable?: boolean;
  default?: string;
}

export interface GeneratedCommandManifestRow {
  kind: string;
  source?: string;
  verb: string;
  aliases?: readonly string[];
  doc?: string;
  budgetClass: string;
  debugGated?: boolean;
  durableIntent?: GeneratedDurableIntent | null;
  args: readonly VerbArgSchema[];
  reasonCodes: readonly string[];
}

export interface GeneratedCommandManifest {
  schema: "successor.commands.manifest.v1";
  source: string;
  regenerationCommand: string;
  commandCount: number;
  rustCommandCount: number;
  debugGatedCount: number;
  commands: readonly GeneratedCommandManifestRow[];
}

export interface GeneratedDurableIntent {
  kind: string;
  when: string;
  notes: string;
}

export interface GeneratedVerbRow {
  kind: string;
  verb: string;
  defaultVerb: string;
  aliases: readonly string[];
  debugGated: boolean;
  budgetClass: string;
  durableIntent: GeneratedDurableIntent | null;
  args: readonly VerbArgSchema[];
  reasonCodes: readonly string[];
}

export interface GeneratedVerbTable {
  schema: "successor.command-verbs.generated.v1";
  sourceManifest: string;
  regenerationCommand: string;
  commandCount: number;
  debugGatedCount: number;
  durableIntentCount: number;
  verbs: readonly GeneratedVerbRow[];
}

export interface VerbRegistryContext {
  state: PlayState;
  slice: SliceSnapshot;
  /** 3D survey store adapter; defaults to lower-case passthrough with metal as the empty family. */
  canonicalResourceFamily?: (value: string | null | undefined) => string;
  /** 3D window-manager seam for /ui. */
  openWindow?: (id: string) => void;
  /** Optional known-window validation for /ui; omitted means the window manager owns validation. */
  knownWindowIds?: readonly string[];
  /** 3D waypoint store seam retained for the pre-registry /waypoint slash. */
  createWaypoint?: (input: { x: number; y: number; areaId: string; name: string }) => { status: string };
  defaultWaypointName?: () => string;
  /** Optional launch identity so /inv matches the 3D inventory's local-owner partition. */
  inventoryIdentity?: InventoryOwnerIdentity;
  /** 3D exit-to-character-select seam retained for /camp and /exitworld. */
  exitToCharacterSelect?: () => string;
}

export interface VerbInvocation {
  invokedVerb: string;
  rawLine: string | null;
}

export interface VerbExecutionResult<Data extends Record<string, unknown> = Record<string, unknown>> {
  schema: "successor.verb-result.v1";
  verb: string;
  kind?: VerbClass;
  class: VerbClass;
  text: string;
  data: Data;
}

export interface VerbRegistryEntry {
  kind?: VerbClass;
  class: VerbClass;
  verb: string;
  aliases: readonly string[];
  argSchema: readonly VerbArgSchema[];
  commandKind?: string;
  defaultVerb?: string;
  budgetClass?: string;
  debugGated?: boolean;
  durableIntent?: GeneratedDurableIntent | null;
  reasonCodes?: readonly string[];
  execute(args: readonly string[], invocation: VerbInvocation): VerbExecutionResult;
}

export interface VerbRegistry {
  entries(): readonly VerbRegistryEntry[];
  authorityEntries(): readonly VerbRegistryEntry[];
  localEntries(): readonly VerbRegistryEntry[];
  queryEntries(): readonly VerbRegistryEntry[];
  resolve(verb: string): VerbRegistryEntry | null;
  resolveCommandKind(kind: string): VerbRegistryEntry | null;
  executeLine(line: string): VerbExecutionResult | null;
}

export interface AuthorityVerbResultData extends Record<string, unknown> {
  commandKind: string;
  queued: boolean;
  commandId: number | null;
  issuedAtTick: number | null;
  debugGated?: boolean;
  command?: AuthorityClientCommand;
  error?: string;
}

export interface LocalVerbResultData extends Record<string, unknown> {
  action: string;
  ok: boolean;
}

export interface QueryVerbResultData extends Record<string, unknown> {
  query: string;
}

export const generatedCommandManifest = parseManifest(manifestRaw);
export const generatedVerbTable = parseVerbTable(verbsRaw);
export const generatedAuthorityVerbRows: readonly GeneratedVerbRow[] = generatedVerbTable.verbs;

const generatedManifestKinds = new Set(generatedCommandManifest.commands.map((row) => row.kind));
const generatedVerbKinds = new Set(generatedVerbTable.verbs.map((row) => row.kind));
for (const kind of generatedManifestKinds) {
  if (!generatedVerbKinds.has(kind)) throw new Error(`verb table missing manifest kind ${kind}`);
}

const windowAliases: Readonly<Record<string, string>> = {
  association: "player-association",
  guild: "player-association",
  pa: "player-association",
  inventory: "inventory",
  inv: "inventory",
  datapad: "datapad",
  data: "datapad",
  character: "character",
  char: "character",
  skills: "skills",
  skill: "skills",
  actions: "actions",
  action: "actions",
  browser: "actions",
  "action-browser": "actions",
  options: "options",
  option: "options",
  survey: "surveyTool",
  "survey-tool": "surveyTool",
  surveytool: "surveyTool",
  travel: "travel",
  loot: "loot",
  examine: "examine",
  target: "targetExamine",
  "target-examine": "targetExamine",
  prop: "propExamine",
  "prop-examine": "propExamine",
  fx: "fxlab",
  fxlab: "fxlab",
};

const numericDomains = new Set([
  "item_numeric_id",
  "inventory_item_numeric_id",
  "item_variant_id",
  "trade_proposal_id",
]);

const numericArgNames = new Set([
  "itemId",
  "variantId",
  "item_id",
  "variant_id",
  "quantity",
  "proposal_id",
]);

const fixedVariantTradeAliases: Readonly<Record<string, { item_id: number; variant_id: number }>> = {
  slug: { item_id: 1101, variant_id: 0 },
  "slug-iron": { item_id: 1101, variant_id: 0 },
  slug_iron: { item_id: 1101, variant_id: 0 },
  ammo: { item_id: 1101, variant_id: 0 },
  creditchip: { item_id: 9002, variant_id: 0 },
  creditchips: { item_id: 9002, variant_id: 0 },
};

const variantBearingTradeAliases: Readonly<Record<string, number>> = {
  chemical: 2002,
  carbon: 2008,
  copper: 2007,
  fuel: 2009,
  flora: 2003,
  hide: 2101,
  iron: 2001,
  petro: 2002,
  petrochemical: 2002,
  polymer: 2010,
};

const variantBearingTradeItemIds = new Set<number>(resourceTaxonomyEntries.map(({ itemId }) => itemId));

export function createVerbRegistry(context: VerbRegistryContext): VerbRegistry {
  const generatedAuthority = generatedAuthorityVerbRows.map((row) => authorityEntry(row, context));
  const authority = generatedAuthority.some((entry) => entry.commandKind === "Deathblow")
    ? generatedAuthority
    : [...generatedAuthority, deathblowEntry(context)];
  const local = localEntries(context);
  const query = queryEntries(context);
  const all = [...authority, ...local, ...query];
  const byVerb = new Map<string, VerbRegistryEntry>();
  const byKind = new Map<string, VerbRegistryEntry>();

  for (const entry of all) {
    registerVerb(byVerb, entry.verb, entry);
    for (const alias of entry.aliases) registerVerb(byVerb, alias, entry);
    if (entry.commandKind) byKind.set(entry.commandKind, entry);
  }

  return {
    entries: () => all,
    authorityEntries: () => authority,
    localEntries: () => local,
    queryEntries: () => query,
    resolve: (verb) => byVerb.get(normalizeVerbName(verb)) ?? null,
    resolveCommandKind: (kind) => byKind.get(kind) ?? null,
    executeLine(line) {
      const parsed = parseVerbLine(line);
      if (!parsed) return null;
      const entry = byVerb.get(parsed.verb);
      if (!entry) return null;
      return entry.execute(parsed.args, { invokedVerb: parsed.verb, rawLine: line });
    },
  };
}

export function parseVerbLine(line: string): { verb: string; args: readonly string[] } | null {
  if (!line.startsWith("/")) return null;
  const tokens = tokenizeVerbLine(line.slice(1).trim());
  const verb = normalizeVerbName(tokens[0] ?? "");
  if (!verb) return null;
  return { verb, args: tokens.slice(1) };
}

export function tokenizeVerbLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function authorityEntry(row: GeneratedVerbRow, context: VerbRegistryContext): VerbRegistryEntry {
  const aliases = [...new Set([row.defaultVerb, ...row.aliases].filter((alias) => alias !== row.verb))];
  return {
    kind: "authority",
    class: "authority",
    verb: row.verb,
    aliases,
    argSchema: row.args,
    commandKind: row.kind,
    defaultVerb: row.defaultVerb,
    budgetClass: row.budgetClass,
    debugGated: row.debugGated,
    durableIntent: row.durableIntent,
    reasonCodes: row.reasonCodes,
    execute(args, invocation) {
      return executeAuthorityRow(row, context, args, invocation);
    },
  };
}
/** Fallback registry row until the generated manifest carries Deathblow; the
 * generated row (post-codegen) reaches the same curated executor below. */
function deathblowEntry(context: VerbRegistryContext): VerbRegistryEntry {
  return {
    kind: "authority",
    class: "authority",
    verb: "deathblow",
    aliases: [],
    argSchema: [{ name: "target", type: "text", required: false }],
    commandKind: "Deathblow",
    defaultVerb: "deathblow",
    budgetClass: "combat",
    debugGated: false,
    durableIntent: null,
    reasonCodes: [],
    execute(args, invocation) {
      return executeDeathblow(context, args, invocation);
    },
  };
}

/** Curated /deathblow: resolve the target locally (explicit selector, else
 * selected, else soft-lock), dispatch exactly ONE authority command, and leave
 * every legality decision to Rust. */
function executeDeathblow(
  context: VerbRegistryContext,
  args: readonly string[],
  invocation: VerbInvocation,
): VerbExecutionResult<AuthorityVerbResultData> {
  clearInvisibleTargetSelection(context);
  const selector = args.join(" ").trim();
  const result = selector
    ? resolveTargetSelector(context, selector)
    : selectedVisibleTarget(context);
  if (!result.ok) {
    const text = result.error === "ambiguous_target"
      ? "DEATHBLOW DENIED — AMBIGUOUS TARGET"
      : "DEATHBLOW DENIED — NO TARGET";
    return authorityResult(invocation.invokedVerb, "Deathblow", null, null, text, {
      error: result.error,
      selector,
      candidates: result.candidates?.map((actor) => actor.id),
    });
  }
  setSelectedTarget(context.state, result.actor.id, true);
  const envelope = enqueueAuthorityDeathblowCommand(
    context.state.authorityCommands,
    result.actor.id,
    issueTick(context),
  );
  return authorityResult(invocation.invokedVerb, "Deathblow", envelope, envelope?.command ?? null,
    envelope ? "DEATHBLOW QUEUED" : "DEATHBLOW DENIED", {
      targetActorId: result.actor.id,
      relation: result.actor.relation,
    });
}

/** No-arg deathblow target order (owner spec): selected first, then soft-lock.
 * Callers run clearInvisibleTargetSelection first, so both ids are visible. */
function selectedVisibleTarget(context: VerbRegistryContext): TargetSelectionResult {
  const selectedId = context.state.selectedActorId ?? context.state.softLockActorId;
  if (!selectedId) return { ok: false, error: "no_target", selector: "" };
  const actor = visibleTargetActors(context, true).find((candidate) => candidate.id === selectedId);
  return actor
    ? { ok: true, actor, selector: selectedId }
    : { ok: false, error: "target_not_visible", selector: selectedId };
}


function executeAuthorityRow(
  row: GeneratedVerbRow,
  context: VerbRegistryContext,
  args: readonly string[],
  invocation: VerbInvocation,
): VerbExecutionResult<AuthorityVerbResultData> {
  const curated = executeCuratedAuthority(row, context, args, invocation);
  if (curated) return curated;
  if (row.debugGated) {
    return authorityResult(invocation.invokedVerb, row.kind, null, null, `/${invocation.invokedVerb.toUpperCase()} DEBUG-GATED`, {
      debugGated: true,
      error: "debug_gated",
    });
  }

  const built = buildAuthorityCommand(row, args);
  if ("error" in built) {
    return authorityResult(invocation.invokedVerb, row.kind, null, null, `${row.verb.toUpperCase()} DENIED — ${built.error.toUpperCase()}`, {
      error: built.error,
    });
  }
  const issuedAtTick = issueTick(context);
  const envelope = enqueueAuthorityCommand(context.state.authorityCommands, built.command, issuedAtTick);
  return authorityResult(invocation.invokedVerb, row.kind, envelope, built.command, `${row.verb.toUpperCase()} QUEUED`, {});
}

function executeCuratedAuthority(
  row: GeneratedVerbRow,
  context: VerbRegistryContext,
  args: readonly string[],
  invocation: VerbInvocation,
): VerbExecutionResult<AuthorityVerbResultData> | null {
  const invoked = invocation.invokedVerb;
  if (row.kind === "Deathblow") {
    return executeDeathblow(context, args, invocation);
  }
  if (row.kind === "SurveyResource" && invoked === "survey") {
    const family = resourceFamilyArgOrSentinel(context, args[0]);
    const queued = enqueueAuthoritySurveyResourceCommand(context.state.authorityCommands, family, issueTick(context));
    const label = family === LAST_RESOURCE_FAMILY_SENTINEL ? "SURVEYING…" : `SURVEYING ${family.toUpperCase()}…`;
    return authorityResult(invoked, row.kind, queued, queued?.command ?? null, queued ? label : "SURVEY DENIED", {});
  }
  if (row.kind === "SampleResource" && (invoked === "sample" || invoked === "stop-sample")) {
    const stopArg = row.args.find((arg) => arg.name === "stop");
    const parsedStop = stopArg && args[1] !== undefined ? parseArgValue(stopArg, args[1]) : { value: false };
    if ("error" in parsedStop) {
      return authorityResult(invoked, row.kind, null, null, "SAMPLE DENIED — BAD STOP", { error: parsedStop.error });
    }
    const family = resourceFamilyArgOrSentinel(context, args[0]);
    const stop = invoked === "stop-sample" || parsedStop.value === true;
    const queued = stop
      ? enqueueAuthorityStopResourceSampleCommand(context.state.authorityCommands, family, issueTick(context))
      : enqueueAuthoritySampleResourceCommand(context.state.authorityCommands, family, issueTick(context));
    const label = stop
      ? "SAMPLING STOPPED"
      : family === LAST_RESOURCE_FAMILY_SENTINEL ? "SAMPLING — HOLD POSITION" : `SAMPLING ${family.toUpperCase()} — HOLD POSITION`;
    return authorityResult(invoked, row.kind, queued, queued?.command ?? null, queued ? label : "SAMPLE DENIED", {});
  }
  if (row.kind === "SetPosture" && invoked === "kneel") {
    const queued = enqueueAuthoritySetPostureCommand(context.state.authorityCommands, "kneel", issueTick(context));
    return authorityResult(invoked, row.kind, queued, queued?.command ?? null, queued ? "KNEELING" : "KNEEL DENIED", {});
  }
  if (row.kind === "SetPosture" && invoked === "stand") {
    const queued = enqueueAuthoritySetPostureCommand(context.state.authorityCommands, "stand", issueTick(context));
    return authorityResult(invoked, row.kind, queued, queued?.command ?? null, queued ? "STANDING" : "STAND DENIED", {});
  }
  if (row.kind === "QueueCombatAction" && invoked === "attack") {
    const parsed = parseCuratedAttackArgs(row, context, args);
    if ("error" in parsed) {
      const text = parsed.error === "no_target" ? "NO TARGET" : "ATTACK DENIED — BAD ACTION";
      return authorityResult(invoked, row.kind, null, null, text, { error: parsed.error });
    }
    const queued = enqueueAuthorityQueueCombatActionCommand(
      context.state.authorityCommands,
      parsed.actionId,
      parsed.targetActorId,
      issueTick(context),
    );
    return authorityResult(
      invoked,
      row.kind,
      queued,
      queued?.command ?? null,
      queued ? "ATTACK QUEUED" : "QUEUE FULL",
      { actionId: parsed.actionId, targetActorId: parsed.targetActorId },
    );
  }
  if ((row.kind === "AddTradeItem" || row.kind === "RemoveTradeItem") && (invoked === "add-trade-item" || invoked === "remove-trade-item")) {
    const positional = args.filter((arg) => !arg.includes("="));
    const named = new Map(args
      .filter((arg) => arg.includes("="))
      .map((arg) => {
        const separator = arg.indexOf("=");
        return [arg.slice(0, separator).replaceAll("-", "_"), arg.slice(separator + 1)] as const;
      }));
    const proposalId = Number(named.get("proposal_id") ?? positional[0]);
    const parsed = parseTradeItemSpec(context, named.get("item") ?? positional[1] ?? "", "offer");
    if (!Number.isInteger(proposalId) || proposalId <= 0 || "error" in parsed || parsed.items.length !== 1) {
      return authorityResult(invoked, row.kind, null, null, `${row.verb.toUpperCase()} DENIED — BAD ITEM`, {
        error: "bad_trade_item",
      });
    }
    const command: AuthorityClientCommand = row.kind === "AddTradeItem"
      ? { AddTradeItem: { proposal_id: proposalId, item: parsed.items[0]! } }
      : { RemoveTradeItem: { proposal_id: proposalId, item: parsed.items[0]! } };
    const queued = enqueueAuthorityCommand(context.state.authorityCommands, command, issueTick(context));
    return authorityResult(
      invoked,
      row.kind,
      queued,
      command,
      queued ? `${row.verb.toUpperCase()} QUEUED` : `${row.verb.toUpperCase()} DENIED`,
      {},
    );
  }
  if (row.kind === "ProposeTrade" && (invoked === "trade" || invoked === "propose-trade")) {
    const parsed = parseCuratedTradeArgs(context, args, invoked === "trade");
    if ("error" in parsed) {
      return authorityResult(invoked, row.kind, null, null, tradeErrorText(parsed.error), { error: parsed.error });
    }
    const queued = enqueueAuthorityProposeTradeCommand(
      context.state.authorityCommands,
      parsed.partnerActorId,
      parsed.offer,
      parsed.request,
      issueTick(context),
    );
    return authorityResult(invoked, row.kind, queued, queued?.command ?? null, queued ? "TRADE QUEUED" : "TRADE DENIED — BAD ITEMS", {
      partnerActorId: parsed.partnerActorId,
      offer: parsed.offer,
      request: parsed.request,
    });
  }
  if (row.kind === "Peace" && invoked === "peace") {
    const queued = enqueueAuthorityPeaceCommand(context.state.authorityCommands, issueTick(context));
    return authorityResult(
      invoked,
      row.kind,
      queued,
      queued.command,
      queued ? "STANDING DOWN" : "PEACE DENIED",
      {},
    );
  }
  if (row.kind === "CloneRespawn" && invoked === "clone") {
    const facilityId = args[0]?.toLowerCase();
    if (facilityId && !(context.slice.cloneFacilities ?? []).some((facility) => facility.id === facilityId)) {
      return authorityResult(
        invoked,
        row.kind,
        null,
        null,
        `UNKNOWN FACILITY — ${(context.slice.cloneFacilities ?? []).map((facility) => facility.id).join(", ") || "none registered"}`,
        { error: "unknown_clone_facility" },
      );
    }
    const queued = enqueueAuthorityCloneRespawnCommand(context.state.authorityCommands, issueTick(context), facilityId);
    return authorityResult(invoked, row.kind, queued, queued.command, queued ? "CLONE ACTIVATION QUEUED" : "CLONE DENIED", {});
  }
  return null;
}

function parseCuratedAttackArgs(
  row: GeneratedVerbRow,
  context: VerbRegistryContext,
  args: readonly string[],
): { actionId: CombatActionId; targetActorId: string } | { error: "bad_action" | "no_target" } {
  const actionValues = row.args.find((arg) => arg.name === "action_id")?.enumValues ?? ["basic_shot", "aimed_shot"];
  const first = args[0]?.trim();
  const second = args[1]?.trim();
  const firstAsAction = first?.toLowerCase().replaceAll("-", "_");
  let actionId = "basic_shot";
  let targetToken = first;
  if (firstAsAction && actionValues.includes(firstAsAction)) {
    actionId = firstAsAction;
    targetToken = second;
  } else if (second) {
    return { error: "bad_action" };
  }
  const targetActorId = resolveCuratedAttackTarget(context, targetToken);
  return targetActorId ? { actionId: actionId as CombatActionId, targetActorId } : { error: "no_target" };
}

function resolveCuratedAttackTarget(context: VerbRegistryContext, rawTarget: string | undefined): string | null {
  const token = rawTarget?.trim();
  if (!token || token === "$target" || token === "$selected") {
    return context.state.selectedActorId ?? context.state.softLockActorId;
  }
  if (token === "$softlock" || token === "$softLock") return context.state.softLockActorId;
  return findActorByName(visibleActorRows(context), token)?.id ?? token;
}

type CuratedTradeParseError = "missing_partner" | "use_offer_request" | "empty_trade" | "bad_offer" | "bad_request" | "trade_variant_required";

function tradeErrorText(error: CuratedTradeParseError): string {
  switch (error) {
    case "missing_partner": return "TRADE DENIED — USE /TRADE PROPOSE <PARTNER> OFFER=ITEM:QTY REQUEST=ITEM:QTY";
    case "use_offer_request": return "TRADE DENIED — SPLIT SIDES WITH OFFER=... REQUEST=... OR ... FOR ...";
    case "empty_trade": return "TRADE DENIED — OFFER OR REQUEST AT LEAST ONE ITEM";
    case "bad_offer": return "TRADE DENIED — BAD OFFER ITEM";
    case "bad_request": return "TRADE DENIED — BAD REQUEST ITEM";
    case "trade_variant_required": return "TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY";
  }
}

function parseCuratedTradeArgs(
  context: VerbRegistryContext,
  args: readonly string[],
  allowProposeSubcommand: boolean,
): { partnerActorId: string; offer: ExchangeTradeItem[]; request: ExchangeTradeItem[] } | { error: CuratedTradeParseError } {
  const rawArgs = [...args];
  if (allowProposeSubcommand && rawArgs[0]?.toLowerCase() === "propose") rawArgs.shift();

  const named = new Map<string, string[]>();
  const positional: string[] = [];
  for (const token of rawArgs) {
    const eq = token.indexOf("=");
    const key = eq > 0 ? normalizeTradeKey(token.slice(0, eq)) : "";
    if (eq > 0 && (key === "partner" || key === "offer" || key === "request")) {
      named.set(key, [...(named.get(key) ?? []), token.slice(eq + 1)]);
      continue;
    }
    positional.push(token);
  }

  const rawPartner = (named.get("partner")?.[0] ?? positional.shift() ?? "").trim();
  if (!rawPartner) return { error: "missing_partner" };
  const partnerActorId = resolveTradePartner(context, rawPartner);
  const hasNamedItems = named.has("offer") || named.has("request");
  let offerRaw: readonly string[];
  let requestRaw: readonly string[];
  if (hasNamedItems) {
    if (positional.length > 0) return { error: "use_offer_request" };
    const offer = splitRepeatedTokens(named.get("offer") ?? []);
    if ("error" in offer) return { error: "bad_offer" };
    const request = splitRepeatedTokens(named.get("request") ?? []);
    if ("error" in request) return { error: "bad_request" };
    offerRaw = offer.values;
    requestRaw = request.values;
  } else {
    const divider = positional.findIndex((token) => {
      const key = token.toLowerCase();
      return key === "for" || key === "request" || key === "requests" || key === "ask" || key === "asks";
    });
    if (divider < 0) return { error: "use_offer_request" };
    offerRaw = positional.slice(0, divider);
    requestRaw = positional.slice(divider + 1);
  }

  const offer = parseTradeItemSpecs(context, offerRaw, "offer");
  if ("error" in offer) return { error: offer.error === "trade_variant_required" ? "trade_variant_required" : "bad_offer" };
  const request = parseTradeItemSpecs(context, requestRaw, "request");
  if ("error" in request) return { error: request.error === "trade_variant_required" ? "trade_variant_required" : "bad_request" };
  if (offer.items.length === 0 && request.items.length === 0) return { error: "empty_trade" };
  return { partnerActorId, offer: offer.items, request: request.items };
}

function normalizeTradeKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (key === "partner_actor_id" || key === "partner-actor-id" || key === "to") return "partner";
  if (key === "offered" || key === "give" || key === "giving") return "offer";
  if (key === "requested" || key === "want" || key === "wants" || key === "ask" || key === "asks") return "request";
  return key;
}

function resolveTradePartner(context: VerbRegistryContext, rawPartner: string): string {
  const token = rawPartner.trim();
  if (token === "$target" || token === "$selected") return context.state.selectedActorId ?? context.state.softLockActorId ?? token;
  if (token === "$softlock" || token === "$softLock") return context.state.softLockActorId ?? token;
  return findActorByName(visibleActorRows(context), token)?.id ?? token;
}

function splitRepeatedTokens(rawValues: readonly string[]): { values: string[] } | { error: string } {
  const values: string[] = [];
  for (const raw of rawValues) {
    const split = splitRepeatedValue(raw);
    if ("error" in split) return split;
    values.push(...split.values);
  }
  return { values };
}

function parseTradeItemSpecs(
  context: VerbRegistryContext,
  rawValues: readonly string[],
  side: "offer" | "request",
): { items: ExchangeTradeItem[] } | { error: string } {
  const items: ExchangeTradeItem[] = [];
  for (const raw of rawValues) {
    const parsed = parseTradeItemSpec(context, raw, side);
    if ("error" in parsed) return parsed;
    items.push(...parsed.items);
  }
  return { items };
}

function parseTradeItemSpec(
  context: VerbRegistryContext,
  raw: string,
  side: "offer" | "request",
): { items: ExchangeTradeItem[] } | { error: string } {
  const token = raw.trim();
  if (token.length === 0 || token === "-" || token.toLowerCase() === "none" || token === "[]") return { items: [] };
  if (token.startsWith("{") || token.startsWith("[")) {
    try {
      const parsed = JSON.parse(token) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const items = values.map(normalizeTradeItemRecord);
      return items.every((item): item is ExchangeTradeItem => item !== null) ? { items } : { error: "bad_trade_item" };
    } catch {
      return { error: "bad_trade_json" };
    }
  }

  const colon = token.lastIndexOf(":");
  if (colon <= 0 || colon === token.length - 1) return { error: "bad_trade_item" };
  const selector = token.slice(0, colon).trim();
  const quantity = Number(token.slice(colon + 1).trim());
  if (!Number.isInteger(quantity) || quantity <= 0) return { error: "bad_trade_quantity" };
  const resolved = resolveTradeItemSelector(context, selector, quantity, side);
  if (!resolved) return { error: "unknown_trade_item" };
  if ("error" in resolved) return { error: resolved.error };
  return { items: [{ ...resolved, quantity }] };
}

function normalizeTradeItemRecord(value: unknown): ExchangeTradeItem | null {
  if (!isRecord(value)) return null;
  const itemId = Number(value.item_id);
  const variantId = Number(value.variant_id);
  const quantity = Number(value.quantity);
  if (!Number.isInteger(itemId) || itemId < 0) return null;
  if (!Number.isInteger(variantId) || variantId < 0) return null;
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  return { item_id: itemId, variant_id: variantId, quantity };
}

function resolveTradeItemSelector(
  context: VerbRegistryContext,
  selector: string,
  quantity: number,
  side: "offer" | "request",
): Pick<ExchangeTradeItem, "item_id" | "variant_id"> | { error: "trade_variant_required" } | null {
  const key = normalizeTradeSelector(selector);

  // Split explicit variant suffixes like @variant_id or #variant_id
  const atIdx = key.indexOf("@");
  const hashIdx = key.indexOf("#");
  let baseKey = key;
  let explicitVariantId: number | null = null;

  if (atIdx !== -1) {
    baseKey = key.slice(0, atIdx);
    const parsed = Number(key.slice(atIdx + 1));
    if (Number.isInteger(parsed) && parsed >= 0) {
      explicitVariantId = parsed;
    }
  } else if (hashIdx !== -1) {
    baseKey = key.slice(0, hashIdx);
    const parsed = Number(key.slice(hashIdx + 1));
    if (Number.isInteger(parsed) && parsed >= 0) {
      explicitVariantId = parsed;
    }
  }

  // Determine base item ID
  let itemId: number | null = null;

  const isNumeric = /^\d+$/u.test(baseKey);
  if (isNumeric) {
    itemId = Number(baseKey);
  } else if (baseKey in fixedVariantTradeAliases) {
    itemId = fixedVariantTradeAliases[baseKey]!.item_id;
  } else if (baseKey in variantBearingTradeAliases) {
    itemId = variantBearingTradeAliases[baseKey]!;
  } else {
    // Search inventory for matching name/alias
    const scoped = tradeScopedInventoryRows(context)
      .map((row) => ({ row, score: tradeRowMatchScore(row, baseKey, quantity, side) }))
      .filter((match): match is { row: InventoryRow; score: number } => match.score !== null)
      .sort((left, right) => left.score - right.score || right.row.available - left.row.available);
    const row = scoped[0]?.row;
    if (row) {
      itemId = row.itemId;
    }
  }

  if (itemId === null) {
    return null;
  }

  // Ammo and physical Credit Chips always stay variant 0.
  if (itemId === 1101 || itemId === 9002) {
    return { item_id: itemId, variant_id: 0 };
  }

  // For variant-bearing items, if no explicit variant is provided, return error.
  if (variantBearingTradeItemIds.has(itemId)) {
    if (explicitVariantId !== null) {
      return { item_id: itemId, variant_id: explicitVariantId };
    }
    return { error: "trade_variant_required" };
  }

  // Not variant-bearing, return with explicit or default 0 variant
  return { item_id: itemId, variant_id: explicitVariantId !== null ? explicitVariantId : 0 };
}

function tradeScopedInventoryRows(context: VerbRegistryContext): InventoryRow[] {
  const scope = inventoryScopeForState(context.state, context.inventoryIdentity);
  return context.state.inventory.filter((row) => row.available > 0 && isInventorySurfaceRowInScope(row, scope));
}

function tradeRowMatchScore(row: InventoryRow, key: string, quantity: number, side: "offer" | "request"): number | null {
  if (side === "offer" && row.available < quantity) return null;
  const item = normalizeTradeSelector(row.item);
  const itemId = String(row.itemId);
  const itemVariant = `${row.itemId}@${row.variantId}`;
  if (key === item || key === itemId || key === itemVariant) return 0;
  if (item.endsWith(key) || item.includes(key)) return 1;
  const aliasItemId = variantBearingTradeAliases[key] ?? fixedVariantTradeAliases[key]?.item_id;
  if (aliasItemId === row.itemId) return 2;
  return null;
}

function normalizeTradeSelector(value: string): string {
  return value.trim().toLowerCase().replace(/['"]/gu, "").replace(/[^a-z0-9@#]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorityResult(
  verb: string,
  commandKind: string,
  envelope: AuthorityClientCommandEnvelope | null,
  command: AuthorityClientCommand | null,
  text: string,
  extra: Partial<AuthorityVerbResultData>,
): VerbExecutionResult<AuthorityVerbResultData> {
  return {
    schema: "successor.verb-result.v1",
    verb,
    kind: "authority",
    class: "authority",
    text,
    data: {
      commandKind,
      queued: envelope !== null,
      commandId: envelope?.command_id ?? null,
      issuedAtTick: envelope?.issued_at_tick ?? null,
      ...(command ? { command } : {}),
      ...extra,
    },
  };
}

function buildAuthorityCommand(row: GeneratedVerbRow, args: readonly string[]): { command: AuthorityClientCommand } | { error: string } {
  const payload: Record<string, unknown> = {};
  const positional: string[] = [];
  const named = new Map<string, string[]>();
  const argNames = new Set(row.args.map((arg) => arg.name));
  for (const token of args) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (argNames.has(key)) {
        named.set(key, [...(named.get(key) ?? []), value]);
        continue;
      }
    }
    positional.push(token);
  }

  let positionalIndex = 0;
  for (const arg of row.args) {
    const rawValues = rawValuesForArg(arg, named, positional, positionalIndex);
    positionalIndex = rawValues.nextPositionalIndex;
    if (rawValues.values.length === 0) {
      if (arg.default !== undefined) {
        const parsedDefault = parseArgValue(arg, arg.default);
        if ("error" in parsedDefault) return parsedDefault;
        payload[arg.name] = parsedDefault.value;
        continue;
      }
      if (arg.required) return { error: `missing_${arg.name}` };
      continue;
    }
    if (arg.repeated) {
      const values: unknown[] = [];
      for (const raw of rawValues.values) {
        const split = splitRepeatedValue(raw);
        if ("error" in split) return { error: `bad_${arg.name}` };
        for (const part of split.values) {
          const parsed = parseArgValue(arg, part);
          if ("error" in parsed) return parsed;
          values.push(parsed.value);
        }
      }
      payload[arg.name] = values;
      continue;
    }
    const parsed = parseArgValue(arg, rawValues.values[0]!);
    if ("error" in parsed) return parsed;
    payload[arg.name] = parsed.value;
  }
  return { command: { [row.kind]: payload } as AuthorityClientCommand };
}

function rawValuesForArg(
  arg: VerbArgSchema,
  named: ReadonlyMap<string, readonly string[]>,
  positional: readonly string[],
  positionalIndex: number,
): { values: readonly string[]; nextPositionalIndex: number } {
  const namedValues = named.get(arg.name);
  if (namedValues) return { values: namedValues, nextPositionalIndex: positionalIndex };
  if (arg.repeated) return { values: positional.slice(positionalIndex), nextPositionalIndex: positional.length };
  const value = positional[positionalIndex];
  return value === undefined
    ? { values: [], nextPositionalIndex: positionalIndex }
    : { values: [value], nextPositionalIndex: positionalIndex + 1 };
}

function splitRepeatedValue(value: string): { values: string[] } | { error: string } {
  const values: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;
  let curlyDepth = 0;
  let squareDepth = 0;
  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{") {
      curlyDepth += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      if (curlyDepth === 0) return { error: "unbalanced_brace" };
      curlyDepth -= 1;
      current += char;
      continue;
    }
    if (char === "[") {
      squareDepth += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      if (squareDepth === 0) return { error: "unbalanced_bracket" };
      squareDepth -= 1;
      current += char;
      continue;
    }
    if (char === "," && curlyDepth === 0 && squareDepth === 0) {
      const part = current.trim();
      if (part.length > 0) values.push(part);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote || curlyDepth !== 0 || squareDepth !== 0) return { error: "unbalanced_structured_arg" };
  const tail = current.trim();
  if (tail.length > 0) values.push(tail);
  return { values };
}

function parseArgValue(arg: VerbArgSchema, raw: string): { value: unknown } | { error: string } {
  if (arg.nullable && raw.toLowerCase() === "null") return { value: null };
  switch (arg.type) {
    case "int":
    case "milli": {
      const value = Number(raw);
      if (!Number.isFinite(value)) return { error: `bad_${arg.name}` };
      return { value: Math.trunc(value) };
    }
    case "text":
      return { value: raw };
    case "enum": {
      if (arg.enumValues && arg.enumValues.length > 0 && !arg.enumValues.includes(raw)) return { error: `bad_${arg.name}` };
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { value: authorityWireEnumByArg[arg.name]?.[raw] ?? raw };
    }
    case "id-domain": {
      if (raw.length === 0) return { error: `bad_${arg.name}` };
      if (raw.startsWith("{") || raw.startsWith("[")) {
        try {
          return { value: JSON.parse(raw) as unknown };
        } catch {
          return { error: `bad_${arg.name}` };
        }
      }
      if (numericDomains.has(arg.domain ?? "") || numericArgNames.has(arg.name)) {
        const value = Number(raw);
        if (!Number.isFinite(value)) return { error: `bad_${arg.name}` };
        return { value: Math.trunc(value) };
      }
      return { value: raw };
    }
  }
}

function localEntries(context: VerbRegistryContext): VerbRegistryEntry[] {
  return [
    {
      kind: "local",
      class: "local",
      verb: "target",
      aliases: [],
      argSchema: [
        { name: "selector", type: "id-domain", required: true, domain: "target_selector", repeated: true },
      ],
      execute(args) {
        return executeTargetVerb(context, args);
      },
    },
    {
      kind: "local",
      class: "local",
      verb: "ui",
      aliases: [],
      argSchema: [{ name: "window", type: "id-domain", required: true, domain: "window_id" }],
      execute(args) {
        return executeUiVerb(context, args);
      },
    },
    {
      kind: "local",
      class: "local",
      verb: "waypoint",
      aliases: [],
      argSchema: [
        { name: "x", type: "int", required: false },
        { name: "y", type: "int", required: false },
        { name: "name", type: "id-domain", required: false, domain: "waypoint_name", repeated: true },
      ],
      execute(args) {
        return executeWaypointVerb(context, args);
      },
    },
    {
      kind: "local",
      class: "local",
      verb: "camp",
      aliases: ["exitworld"],
      argSchema: [],
      execute() {
        const text = context.exitToCharacterSelect?.() ?? "CAMP DENIED";
        return localResult("camp", "exit_world", text !== "CAMP DENIED", text, {});
      },
    },
  ];
}

function queryEntries(context: VerbRegistryContext): VerbRegistryEntry[] {
  const query = (verb: string, execute: (args: readonly string[]) => VerbExecutionResult): VerbRegistryEntry => ({
    kind: "query",
    class: "query",
    verb,
    aliases: [],
    argSchema: [],
    execute,
  });
  return [
    query("where", () => executeWhereQuery(context)),
    query("vitals", () => executeVitalsQuery(context)),
    query("inv", (args) => executeInventoryQuery(context, args)),
    query("bank", () => executeBankQuery(context)),
    query("wallet", () => executeWalletQuery(context)),
    query("nearby", (args) => executeNearbyQuery(context, args)),
    query("queue", () => executeQueueQuery(context)),
    query("group", () => executeGroupQuery(context)),
    query("guild", () => executeGuildQuery(context)),
    query("budget", () => executeBudgetQuery(context)),
  ];
}

function executeTargetVerb(context: VerbRegistryContext, args: readonly string[]): VerbExecutionResult<LocalVerbResultData> {
  clearInvisibleTargetSelection(context);
  const selector = args.join(" ").trim();
  if (selector.toLowerCase() === "clear") {
    setSelectedTarget(context.state, null, true);
    return localResult("target", "target", true, "TARGET CLEARED", { selector });
  }
  if (!selector) return localResult("target", "target", false, "TARGET DENIED — NO TARGET", { error: "no_target" });
  const result = resolveTargetSelector(context, selector);
  if (!result.ok) {
    const text = result.error === "ambiguous_target" ? "TARGET DENIED — AMBIGUOUS TARGET" : "TARGET NOT FOUND";
    return localResult("target", "target", false, text, {
      selector,
      error: result.error,
      candidates: result.candidates?.map((actor) => actor.id),
    });
  }
  setSelectedTarget(context.state, result.actor.id, true);
  return localResult("target", "target", true, `TARGET ${(result.actor.label ?? result.actor.id).toUpperCase()}`, {
    selector,
    target: result.actor,
    relation: result.actor.relation,
  });
}

function executeUiVerb(context: VerbRegistryContext, args: readonly string[]): VerbExecutionResult<LocalVerbResultData> {
  const raw = args.join("-").trim().toLowerCase();
  if (!raw) return localResult("ui", "ui", false, "UI DENIED — USE /UI <WINDOW>", {});
  const windowId = windowAliases[raw] ?? raw;
  if (context.knownWindowIds && !context.knownWindowIds.includes(windowId)) {
    return localResult("ui", "ui", false, "UI DENIED — UNKNOWN WINDOW", { windowId });
  }
  if (!context.openWindow) return localResult("ui", "ui", false, "UI DENIED — NO WINDOW MANAGER", { windowId });
  context.openWindow(windowId);
  return localResult("ui", "ui", true, `UI ${windowId.toUpperCase()}`, { windowId });
}

function executeWaypointVerb(context: VerbRegistryContext, args: readonly string[]): VerbExecutionResult<LocalVerbResultData> {
  if (!context.createWaypoint) return localResult("waypoint", "waypoint", false, "WAYPOINT DENIED", {});
  const area = currentArea(context.slice, context.state);
  let x = Math.floor(context.state.player.x);
  let y = Math.floor(context.state.player.y);
  let nameStart = 0;
  if (args.length >= 2 && numericToken(args[0]) && numericToken(args[1])) {
    x = Number(args[0]);
    y = Number(args[1]);
    nameStart = 2;
  } else if (args.length > 0 && (numericToken(args[0]) || numericToken(args[1]))) {
    return localResult("waypoint", "waypoint", false, "WAYPOINT DENIED — USE /WAYPOINT <X> <Y> [NAME]", {});
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return localResult("waypoint", "waypoint", false, "WAYPOINT DENIED — BAD COORDS", {});
  if (x < 0 || y < 0 || x >= area.width || y >= area.height) {
    return localResult(
      "waypoint",
      "waypoint",
      false,
      `WAYPOINT DENIED — OUTSIDE ${area.id.toUpperCase()} 0..${area.width - 1} / 0..${area.height - 1}`,
      { x, y, areaId: area.id },
    );
  }
  const name = args.slice(nameStart).join(" ").trim() || context.defaultWaypointName?.() || "Waypoint";
  const result = context.createWaypoint({ x, y, areaId: area.id, name });
  return localResult("waypoint", "waypoint", true, result.status, { x, y, areaId: area.id, name });
}

function localResult(
  verb: string,
  action: string,
  ok: boolean,
  text: string,
  extra: Record<string, unknown>,
): VerbExecutionResult<LocalVerbResultData> {
  return {
    schema: "successor.verb-result.v1",
    verb,
    kind: "local",
    class: "local",
    text,
    data: { action, ok, ...extra },
  };
}

function executeWhereQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const position = playerPosition(context);
  const data = {
    query: "where",
    schema: "successor.query.where.v1",
    areaId: position.areaId,
    areaName: currentArea(context.slice, context.state).name,
    x: position.x,
    y: position.y,
    facing: position.facing,
    tick: context.slice.tick,
    serverTick: context.state.serverAuthority.snapshotTick,
    source: position.source,
  };
  return queryResult("where", `WHERE ${data.areaId} ${formatCoord(data.x)},${formatCoord(data.y)} facing ${data.facing}`, data);
}

function executeVitalsQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const playerId = playerActorId(context);
  const serverActor = playerId ? context.state.serverAuthority.actors[playerId] ?? null : null;
  const localActor = playerId ? context.slice.actors.find((actor) => actor.id === playerId) ?? null : null;
  const combat = playerId ? context.state.actors[playerId] ?? null : null;
  const vitals = serverActor?.vitals ?? combat?.vitals ?? localActor?.vitals ?? null;
  const maxVitals = serverActor?.maxVitals ?? combat?.maxVitals ?? localActor?.maxVitals ?? null;
  const data = {
    query: "vitals",
    schema: "successor.query.vitals.v1",
    actorId: playerId,
    lifeState: serverActor?.lifeState ?? combat?.lifeState ?? "alive",
    posture: serverActor?.posture ?? null,
    vitals,
    maxVitals,
    statuses: serverActor?.statuses ?? combat?.statuses ?? [],
  };
  const text = vitals && maxVitals
    ? `VITALS H ${vitals.health}/${maxVitals.health} · A ${vitals.action}/${maxVitals.action} · S ${vitals.spirit}/${maxVitals.spirit}`
    : "VITALS UNKNOWN";
  return queryResult("vitals", text, data);
}

function executeInventoryQuery(context: VerbRegistryContext, args: readonly string[]): VerbExecutionResult<QueryVerbResultData> {
  const filter = args.join(" ").trim().toLowerCase();
  const scope = inventoryScopeForState(context.state, context.inventoryIdentity);
  const rows = context.state.inventory
    .filter((row) => isInventorySurfaceRowInScope(row, scope))
    .filter((row) => inventoryRowMatches(row, filter))
    .map(inventoryQueryRow);
  const containers = inventoryContainerGroups(rows);
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const totalAvailable = rows.reduce((sum, row) => sum + row.available, 0);
  const data = {
    query: "inv",
    schema: "successor.query.inventory.v1",
    filter: filter || null,
    totalStacks: rows.length,
    totalContainers: containers.length,
    totalQuantity,
    totalAvailable,
    containers,
    rows,
  };
  return queryResult("inv", renderInventoryQueryText(rows.length, totalAvailable, containers), data);
}
function executeBankQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const bank = context.state.serverAuthority.bank;
  const items = bank?.items
    .filter((item) => item.available > 0)
    .map((item) => ({ ...item })) ?? [];
  const data = {
    query: "bank",
    schema: "successor.query.bank.v1",
    available: bank !== null,
    credits: bank?.credits ?? null,
    items,
    backupPresent: bank?.backupPresent ?? false,
    backupSavedTick: bank?.backupSavedTick ?? null,
    backupSkillCount: bank?.backupSkillCount ?? 0,
    backupCost: bank?.backupCost ?? null,
  };
  const text = bank
    ? `BANK ${bank.credits} CR · ${items.length} STACKS · BACKUP ${bank.backupPresent ? "ON FILE" : "NONE"}`
    : "BANK UNAVAILABLE";
  return queryResult("bank", text, data);
}
function executeWalletQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const actorId = playerActorId(context);
  const serverActor = actorId ? context.state.serverAuthority.actors[actorId] ?? null : null;
  const localActor = actorId ? context.slice.actors.find((actor) => actor.id === actorId) ?? null : null;
  const credits = serverActor?.credits ?? localActor?.credits ?? null;
  const data = {
    query: "wallet",
    schema: "successor.query.wallet.v1",
    actorId,
    credits,
  };
  return queryResult("wallet", credits === null ? "WALLET UNKNOWN" : `WALLET ${credits} CR`, data);
}



// Threat legibility (owner 2026-07-08): among hostile-RELATION actors, the ones
// that will auto-aggro read "hostile"; provoked-only (won't aggro unless attacked)
// read "wary" — the same willAutoAggro key the nameplate/minimap colours use. The
// relation (and the `/target`/`/nearby` selectors) stay DEF-4/DEF-10 ordered.
function nearbyThreatWord(actor: ActorRow): "hostile" | "wary" | null {
  if (actor.relation !== "hostile") return null;
  return actor.willAutoAggro ? "hostile" : "wary";
}

function executeNearbyQuery(context: VerbRegistryContext, args: readonly string[]): VerbExecutionResult<QueryVerbResultData> {
  const filter = (args[0] ?? "all").toLowerCase();
  const origin = playerPosition(context);
  const actors = visibleActorRows(context)
    .filter((actor) => filter === "all"
      || (filter === "hostile" && actor.relation === "hostile")
      || (filter === "corpse" && actor.lifeState !== "alive"))
    .map((actor) => ({ ...actor, distanceCells: distance(origin, actor), threat: nearbyThreatWord(actor) }))
    .sort((left, right) => left.distanceCells - right.distanceCells)
    .slice(0, 12);
  const props = (filter === "all" || filter === "prop" || filter === "props")
    ? context.slice.props
      .filter((prop) => prop.areaId === context.state.activeAreaId)
      .map((prop) => ({
        id: prop.id,
        label: prop.label,
        kind: prop.kind,
        x: prop.cell.x,
        y: prop.cell.y,
        distanceCells: distance(origin, { x: prop.cell.x, y: prop.cell.y }),
      }))
      .sort((left, right) => left.distanceCells - right.distanceCells)
      .slice(0, 12)
    : [];
  const data = {
    query: "nearby",
    schema: "successor.query.nearby.v1",
    filter,
    origin: { areaId: origin.areaId, x: origin.x, y: origin.y },
    actors,
    props,
  };
  const count = actors.length + props.length;
  const leadActor = actors[0];
  const lead = leadActor
    ? (leadActor.descriptor ? `${leadActor.label}, ${leadActor.descriptor}` : leadActor.label)
    : props[0]?.label ?? null;
  const leadThreat = actors.length > 0 ? actors[0]!.threat : null;
  const leadText = lead ? ` — ${lead}${leadThreat ? ` (${leadThreat})` : ""}` : "";
  const text = count === 0
    ? `NEARBY ${filter.toUpperCase()} NONE`
    : `NEARBY ${filter.toUpperCase()} ${count}${leadText}`;
  return queryResult("nearby", text, data);
}

function executeQueueQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const pendingCommands = context.state.authorityCommands.pending.map((envelope) => ({
    commandId: envelope.command_id,
    kind: authorityCommandKind(envelope.command),
    issuedAtTick: envelope.issued_at_tick,
  }));
  const view = context.state.abilityQueue.view;
  const data = {
    query: "queue",
    schema: "successor.query.queue.v1",
    abilityQueue: view,
    pendingCommands,
    pendingCommandCount: pendingCommands.length,
  };
  const abilityCount = (view?.entries.length ?? 0) + (view?.repeatIntent ? 1 : 0);
  const text = `QUEUE ${abilityCount} ABILITY · ${pendingCommands.length} WIRE PENDING`;
  return queryResult("queue", text, data);
}

function executeGroupQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const view = context.state.serverAuthority.group;
  const members = (view.members ?? []).map((member) => ({
    ...member,
    vitals: { ...member.vitals },
    maxVitals: { ...member.maxVitals },
  }));
  const data = {
    query: "group",
    schema: "successor.query.group.v1",
    group: view.group ? {
      ...view.group,
      memberActorIds: view.group.memberActorIds.slice(),
    } : null,
    members,
    pendingInvite: view.pendingInvite ? { ...view.pendingInvite } : null,
  };
  const text = members.length > 0
    ? `GROUP ${members.length} · ${members.map((member) => `${member.isLeader ? "*" : ""}${member.name}`).join(" · ")}`
    : data.pendingInvite
      ? `GROUP INVITE FROM ${data.pendingInvite.inviterName}`
      : "GROUP NONE";
  return queryResult("group", text, data);
}
function executeGuildQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const view = context.state.serverAuthority.guilds;
  const data = {
    query: "guild",
    schema: "successor.query.guild.v1",
    guild: view.guild
      ? { ...view.guild, wars: (view.guild.wars ?? []).map((war) => ({ ...war })) }
      : null,
    roster: (view.roster ?? []).map((member) => ({
      ...member,
      permissions: [...(member.permissions ?? [])],
    })),
    pendingInvites: (view.pendingInvites ?? []).map((invite) => ({ ...invite })),
    directory: (view.directory ?? []).map((entry) => ({ ...entry })),
  };
  const text = data.guild
    ? `GUILD ${data.guild.tag} · ${data.roster.length} MEMBERS · ${data.guild.wars.length} WARS`
    : data.pendingInvites.length > 0
      ? `GUILD INVITES ${data.pendingInvites.length}`
      : `GUILD DIRECTORY ${data.directory.length}`;
  return queryResult("guild", text, data);
}

function executeBudgetQuery(context: VerbRegistryContext): VerbExecutionResult<QueryVerbResultData> {
  const recentIngressRejects = context.state.serverAuthority.receiptLog
    .filter((receipt) => receipt.accepted === false && receipt.reasonCode === "ingress_budget_exhausted")
    .slice(-8)
    .map((receipt) => ({
      commandId: receipt.commandId,
      tick: receipt.tick,
      kind: sentCommandKind(context.state, receipt.commandId),
      receivedAtMs: receipt.receivedAtMs,
    }));
  const data = {
    query: "budget",
    schema: "successor.query.budget.v1",
    counters: {
      sent: context.state.serverAuthority.sentCommands,
      accepted: context.state.serverAuthority.acceptedCommands,
      rejected: context.state.serverAuthority.rejectedCommands,
      pending: context.state.authorityCommands.pending.length,
    },
    totalByKind: { ...context.state.authorityCommands.totalByKind },
    lastReceipt: context.state.serverAuthority.lastReceipt,
    recentIngressRejects,
  };
  const text = `BUDGET sent ${data.counters.sent} · accepted ${data.counters.accepted} · rejected ${data.counters.rejected} · ingress rejects ${recentIngressRejects.length}`;
  return queryResult("budget", text, data);
}

function queryResult<Data extends QueryVerbResultData>(verb: string, text: string, data: Data): VerbExecutionResult<Data> {
  return {
    schema: "successor.verb-result.v1",
    verb,
    kind: "query",
    class: "query",
    text,
    data,
  };
}

interface ActorRow extends ActorRelationSubject {
  areaId: string;
  x: number;
  y: number;
  relation: ActorRelationToPlayer;
  lifeState: string;
  /** actor descriptor for /nearby + /target reads ("a rogue drifter"); server-authoritative. */
  descriptor?: string;
}

function visibleActorRows(context: VerbRegistryContext): ActorRow[] {
  const playerId = playerActorId(context);
  const localById = new Map(context.slice.actors.map((actor) => [actor.id, actor]));
  const sourceRows = context.state.serverAuthority.enabled
    && context.state.serverAuthority.sourceMatchesClient !== false
    && Object.keys(context.state.serverAuthority.actors).length > 0
    ? Object.values(context.state.serverAuthority.actors).map((actor) => actorRowFromServer(context, actor, localById.get(actor.id) ?? null))
    : context.slice.actors.map((actor) => actorRowFromLocal(context, actor));
  return sourceRows
    .filter((actor): actor is ActorRow => actor !== null)
    .filter((actor) => actor.id !== playerId && actor.areaId === context.state.activeAreaId);
}

function actorRowFromServer(context: VerbRegistryContext, actor: ServerAuthorityActorState, local: ActorSnapshot | null): ActorRow | null {
  if (actor.lifeState === "respawning") return null;
  const subject = {
    id: actor.id,
    label: actor.label,
    role: actor.role ?? local?.role ?? null,
    sprite: actor.sprite ?? local?.sprite ?? null,
    factionId: actor.factionId ?? local?.factionId ?? null,
    aiAttitude: actor.aiAttitude ?? local?.aiAttitude ?? null,
    willAutoAggro: actor.willAutoAggro ?? null,
    playerOrganizationId: actor.playerOrganizationId ?? local?.playerOrganizationId ?? null,
    playerOrganizationTag: actor.playerOrganizationTag ?? local?.playerOrganizationTag ?? null,
  };
  return {
    ...subject,
    areaId: actor.areaId,
    x: actor.x,
    y: actor.y,
    relation: actorRelationToPlayer(subject, context.slice, context.state),
    lifeState: actor.lifeState,
    descriptor: actor.descriptor,
  };
}

function actorRowFromLocal(context: VerbRegistryContext, actor: ActorSnapshot): ActorRow {
  const subject = {
    id: actor.id,
    label: actor.label,
    role: actor.role,
    sprite: actor.sprite,
    factionId: actor.factionId ?? null,
    aiAttitude: actor.aiAttitude ?? null,
    willAutoAggro: null,
    playerOrganizationId: actor.playerOrganizationId ?? null,
    playerOrganizationTag: actor.playerOrganizationTag ?? null,
  };
  const combat = context.state.actors[actor.id];
  return {
    ...subject,
    areaId: actor.areaId,
    x: actor.cell.x,
    y: actor.cell.y,
    relation: actorRelationToPlayer(subject, context.slice, context.state),
    lifeState: combat?.lifeState ?? "alive",
  };
}

function findActorByName(actors: readonly ActorRow[], selector: string): ActorRow | null {
  const needle = selector.trim().toLowerCase();
  if (!needle) return null;
  const exact = actors.find((actor) => actor.id.toLowerCase() === needle || (actor.label ?? "").toLowerCase() === needle);
  if (exact) return exact;
  return actors.find((actor) => actor.id.toLowerCase().includes(needle) || (actor.label ?? "").toLowerCase().includes(needle)) ?? null;
}

function playerPosition(context: VerbRegistryContext): { areaId: string; x: number; y: number; facing: PlayState["facing"]; source: "server" | "client" } {
  const playerId = playerActorId(context);
  const serverActor = playerId ? context.state.serverAuthority.actors[playerId] ?? null : null;
  if (serverActor && serverActor.lifeState !== "respawning") {
    return {
      areaId: serverActor.areaId,
      x: serverActor.x,
      y: serverActor.y,
      facing: serverActor.direction,
      source: "server",
    };
  }
  return {
    areaId: context.state.activeAreaId,
    x: context.state.player.x,
    y: context.state.player.y,
    facing: context.state.facing,
    source: "client",
  };
}

function playerActorId(context: VerbRegistryContext): string {
  return context.state.serverAuthority.playerActorId ?? context.state.playerActorId ?? context.slice.camera.followActor;
}

function sentCommandKind(state: PlayState, commandId: number): AuthorityClientCommandKind | "unknown" {
  return state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === commandId)?.kind ?? "unknown";
}

interface InventoryQueryRow {
  container: string;
  stackId: number | null;
  item: string;
  itemKey: string | null;
  itemId: number;
  variantId: number;
  quantity: number;
  available: number;
  reserved: number;
}

interface InventoryQueryContainerGroup {
  container: string;
  totalStacks: number;
  totalQuantity: number;
  totalAvailable: number;
  rows: InventoryQueryRow[];
}

function inventoryQueryRow(row: InventoryRow): InventoryQueryRow {
  return {
    container: row.container,
    stackId: row.stackId ?? null,
    item: row.item,
    itemKey: row.itemKey ?? null,
    itemId: row.itemId,
    variantId: row.variantId,
    quantity: row.quantity,
    available: row.available,
    reserved: row.reserved,
  };
}

function inventoryContainerGroups(rows: readonly InventoryQueryRow[]): InventoryQueryContainerGroup[] {
  const groupsByContainer = new Map<string, InventoryQueryContainerGroup>();
  for (const row of rows) {
    let group = groupsByContainer.get(row.container);
    if (!group) {
      group = { container: row.container, totalStacks: 0, totalQuantity: 0, totalAvailable: 0, rows: [] };
      groupsByContainer.set(row.container, group);
    }
    group.totalStacks += 1;
    group.totalQuantity += row.quantity;
    group.totalAvailable += row.available;
    group.rows.push(row);
  }
  return [...groupsByContainer.values()];
}

function renderInventoryQueryText(
  totalStacks: number,
  totalAvailable: number,
  containers: readonly InventoryQueryContainerGroup[],
): string {
  if (totalStacks === 0) return "INV EMPTY";
  const groups = containers
    .map((group) => `[${group.container}] ${stackLabel(group.totalStacks)}/${group.totalAvailable} AVAILABLE`)
    .join(" · ");
  return `INV ${stackLabel(totalStacks)} · ${totalAvailable} AVAILABLE · ${groups}`;
}

function stackLabel(count: number): string {
  return `${count} STACK${count === 1 ? "" : "S"}`;
}

function inventoryRowMatches(row: InventoryRow, filter: string): boolean {
  if (!filter) return true;
  const haystack = [row.container, row.item, row.itemKey ?? "", String(row.itemId), String(row.variantId)].join(" ").toLowerCase();
  return haystack.includes(filter);
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/**
 * Bare-use reuse-last sentinel for /survey //sample (reuse-last-parameters). When the
 * player runs the verb with no family arg we send this token; the shard resolves
 * it to the session's last resource family before forwarding (server protocol
 * `lastResourceFamilySentinel`). Ingress-only — the authority never sees it.
 */
export const LAST_RESOURCE_FAMILY_SENTINEL = "$last";

function resourceFamilyArgOrSentinel(context: VerbRegistryContext, arg: string | undefined): string {
  return arg !== undefined && arg.trim().length > 0
    ? canonicalResourceFamily(context, arg)
    : LAST_RESOURCE_FAMILY_SENTINEL;
}

function canonicalResourceFamily(context: VerbRegistryContext, value: string | null | undefined): string {
  return context.canonicalResourceFamily?.(value) ?? (value?.trim().toLowerCase() || "metal");
}

function issueTick(context: VerbRegistryContext): number {
  return authorityIssuedAtServerTick(context.state, context.slice.tickRateHz, context.slice.tick);
}

function registerVerb(map: Map<string, VerbRegistryEntry>, verb: string, entry: VerbRegistryEntry): void {
  const normalized = normalizeVerbName(verb);
  if (!normalized) return;
  const existing = map.get(normalized);
  if (existing && existing !== entry) {
    // Fail-fast: a verb/alias claimed by two commands would silently last-wins
    // shadow one of them (the HarvestCrop/HarvestCorpse "harvest" class). The
    // registry REJECTS the collision at construction so it can never ship.
    const owner = (e: VerbRegistryEntry) => e.commandKind ?? e.verb;
    throw new Error(
      `verb registry alias collision: "${normalized}" claimed by both ${owner(existing)} and ${owner(entry)} — verbs+aliases must be globally unique`,
    );
  }
  map.set(normalized, entry);
}

function normalizeVerbName(verb: string): string {
  return verb.trim().replace(/^\/+/, "").toLowerCase();
}

function numericToken(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return Number.isFinite(Number(trimmed));
}

function formatCoord(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function parseManifest(raw: string): GeneratedCommandManifest {
  const parsed = JSON.parse(raw) as GeneratedCommandManifest;
  if (parsed.schema !== "successor.commands.manifest.v1" || !Array.isArray(parsed.commands)) {
    throw new Error("invalid successor command manifest");
  }
  return parsed;
}

function parseVerbTable(raw: string): GeneratedVerbTable {
  const parsed = JSON.parse(raw) as GeneratedVerbTable;
  if (parsed.schema !== "successor.command-verbs.generated.v1" || !Array.isArray(parsed.verbs)) {
    throw new Error("invalid successor generated verb table");
  }
  return parsed;
}
