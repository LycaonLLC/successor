import { MACRO_ENGINE_DEFAULT_CAPS } from "./constants";
import { parseMacroBody, type MacroProgram } from "./parser";

/**
 * STARTER PACK — the checked-in built-in macro library.
 *
 * Provenance model (all three clients):
 *   character — server character record (successor.macros.v1), user-owned,
 *               the ONLY writable provider. Highest precedence.
 *   local     — read-only .macro files on the player's disk (Electron
 *               userData/macros, TUI XDG config dir). Middle precedence.
 *   starter   — this module. Lowest precedence, immutable, always present
 *               (browser builds included — no FS access required).
 * Name collisions resolve to the higher provider; the losers are shadowed.
 * Starter/local macros run directly but must be copied/saved into the
 * character record before editing.
 *
 * Every starter body uses ONLY parser-valid statements and currently
 * registered non-debug verbs (generated authority table + local + query).
 * Bodies are parse-validated at module load; registry resolution (verb
 * exists, not debug-gated, /until targets a query verb) is asserted in
 * starterPack.test.ts against a real createVerbRegistry.
 *
 * Honesty rule: flows the verb/query model cannot automate without ids the
 * player must supply are either omitted (trade, craft, farm, travel tickets,
 * loot) or take the id as a run argument ($1/$2 — extractor-round, sidestep).
 */

export type MacroProvider = "character" | "local" | "starter";

/** Read-only .macro file rules shared by the desktop IPC and TUI loaders. */
export const LOCAL_MACRO_FILE_RULES = Object.freeze({
  extension: ".macro",
  maxFiles: MACRO_ENGINE_DEFAULT_CAPS.macrosPerCharacter,
  maxBytes: MACRO_ENGINE_DEFAULT_CAPS.bodyBytes,
  /** Basename without extension; also the macro name. Store-name parity (≤48). */
  namePattern: /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/u,
});

export interface StarterMacro {
  readonly name: string;
  readonly iconId: string;
  /** One terse in-world line for library rows. */
  readonly summary: string;
  readonly body: string;
}

export const STARTER_MACROS: readonly StarterMacro[] = Object.freeze([
  {
    name: "field-report",
    iconId: "macro:command",
    summary: "position, vitals, contacts, queue, packs, budget",
    body: [
      "# field report — read the ground before acting",
      "/where",
      "/vitals",
      "/nearby",
      "/queue",
      "/inv",
      "/budget",
    ].join("\n"),
  },
  {
    name: "open-fire",
    iconId: "macro:command",
    summary: "engage the nearest hostile, halt clean on refusal",
    body: [
      "# open on the nearest hostile; halts if nothing bites",
      "/onreject halt",
      "/target nearest hostile",
      "/attack basic_shot",
      "/waitreceipt timeout=6",
      "/attack aimed_shot",
      "/waitreceipt timeout=6",
    ].join("\n"),
  },
  {
    name: "stand-down",
    iconId: "macro:command",
    summary: "break contact, clear the ability queue",
    body: [
      "# break contact and clear the queue",
      "/onreject continue",
      "/peace",
      "/waitreceipt timeout=6",
      "/cancel-queue scope=all",
      "/waitreceipt timeout=6",
    ].join("\n"),
  },
  {
    name: "take-a-knee",
    iconId: "macro:command",
    summary: "kneel until action recovers, then stand",
    body: [
      "# kneel until action recovers, then stand",
      "/onreject continue",
      "/posture kneel",
      "/waitreceipt timeout=6",
      "/until vitals.vitals.action >= 75 timeout=60",
      "/posture stand",
    ].join("\n"),
  },
  {
    name: "prospect-metal",
    iconId: "macro:command",
    summary: "survey metal, then pull a sample on the spot",
    body: [
      "# survey metal, then sample where the reading lands",
      "/onreject halt",
      "/survey metal",
      "/waitreceipt timeout=10",
      "/pause 2",
      "/sample metal",
      "/waitreceipt timeout=10",
    ].join("\n"),
  },
  {
    name: "extractor-round",
    iconId: "macro:command",
    summary: "crank + collect a placed extractor by id ($1)",
    body: [
      "# tend a placed extractor: /macro run extractor-round <extractor-id>",
      "/onreject halt",
      "/crank-extractor $1",
      "/waitreceipt timeout=8",
      "/pause 2",
      "/stop-crank",
      "/waitreceipt timeout=8",
      "/collect-extractor $1",
      "/waitreceipt timeout=8",
    ].join("\n"),
  },
  {
    name: "make-camp",
    iconId: "macro:command",
    summary: "pitch camp, breathe, strike it",
    body: [
      "# pitch camp, breathe, strike it",
      "/onreject halt",
      "/place-camp",
      "/waitreceipt timeout=8",
      "/pause 15",
      "/pack-up-camp",
      "/waitreceipt timeout=8",
    ].join("\n"),
  },
  {
    name: "sidestep",
    iconId: "macro:command",
    summary: "one guarded step: run with <dx> <dy>",
    body: [
      "# one guarded step: /macro run sidestep <dx> <dy>",
      "/onreject halt",
      "/move $1 $2 30",
      "/waitreceipt timeout=4",
      "/where",
    ].join("\n"),
  },
]);

/** Case-insensitive starter lookup (library name resolution parity). */
export function starterMacroByName(name: string): StarterMacro | null {
  const key = name.trim().toLowerCase();
  return STARTER_MACROS.find((macro) => macro.name.toLowerCase() === key) ?? null;
}

/** Registry shape both MacroVerbRegistry (kind) and VerbRegistry (class) satisfy. */
interface ResolvableRegistry {
  resolve(verb: string): { kind?: string; class?: string; debugGated?: boolean } | null;
}

/**
 * Cross-check every starter against a live registry: each verb statement
 * must resolve to a registered non-debug verb and each /until predicate
 * must target a query verb. Returns human-readable issues; [] = clean.
 */
export function starterMacroIssues(registry: ResolvableRegistry): string[] {
  const issues: string[] = [];
  for (const macro of STARTER_MACROS) {
    const program = starterProgram(macro);
    for (const statement of program.statements) {
      if (statement.type === "verb") {
        const entry = registry.resolve(statement.verb);
        if (!entry) {
          issues.push(`${macro.name} L${statement.line}: unknown verb /${statement.verb}`);
        } else if (entry.debugGated) {
          issues.push(`${macro.name} L${statement.line}: debug-gated verb /${statement.verb}`);
        }
      } else if (statement.type === "until") {
        const entry = registry.resolve(statement.predicate.queryVerb);
        const kind = entry?.kind ?? entry?.class;
        if (!entry) {
          issues.push(`${macro.name} L${statement.line}: unknown query ${statement.predicate.queryVerb}`);
        } else if (kind !== "query") {
          issues.push(`${macro.name} L${statement.line}: /until target ${statement.predicate.queryVerb} is not a query verb`);
        }
      }
    }
  }
  return issues;
}

function starterProgram(macro: StarterMacro): MacroProgram {
  const cached = programCache.get(macro.name);
  if (cached) return cached;
  const program = parseMacroBody(macro.body);
  programCache.set(macro.name, program);
  return program;
}

const programCache = new Map<string, MacroProgram>();

// Module-time template validation: every checked-in body must parse under
// default caps and carry a unique name. A bad template fails the import, not
// the player's session mid-run.
{
  const seen = new Set<string>();
  for (const macro of STARTER_MACROS) {
    const key = macro.name.toLowerCase();
    if (seen.has(key)) throw new Error(`starter macro duplicate name: ${macro.name}`);
    seen.add(key);
    starterProgram(macro); // throws MacroParseError on an invalid template
  }
}
