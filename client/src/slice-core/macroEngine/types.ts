import type { MacroEngineCaps, MacroEngineCapOverrides } from "./constants";
import type { VerbRegistry } from "../verbRegistry";

export type MacroScalar = string | number | boolean | null;
export type MacroValue = MacroScalar | MacroValue[] | { readonly [key: string]: MacroValue };

export type MacroVerbKind = "authority" | "local" | "query";
export type MacroArgSchemaType = "int" | "milli" | "enum" | "id-domain" | "text" | "string" | "number" | "boolean";

export interface MacroVerbArgSchema {
  readonly name: string;
  readonly type: MacroArgSchemaType;
  readonly required?: boolean;
  readonly enumValues?: readonly string[];
  readonly domain?: string;
  readonly repeated?: boolean;
  readonly nullable?: boolean;
  readonly default?: MacroValue;
}

export interface MacroInvocationArg {
  readonly key?: string;
  readonly value: MacroValue;
  readonly raw: string;
}

export interface MacroVerbInvocation {
  readonly runId: string;
  readonly macroName: string;
  readonly verb: string;
  readonly kind: MacroVerbKind;
  readonly tick: number;
  readonly depth: number;
  readonly args: readonly MacroInvocationArg[];
  readonly positional: readonly MacroValue[];
  readonly named: Readonly<Record<string, MacroValue>>;
}

export interface MacroReceiptTarget {
  readonly commandId?: string | number;
  readonly token?: string;
  readonly kind?: string;
}

export interface MacroCommandReceipt {
  readonly commandId?: string | number;
  readonly command_id?: number;
  readonly token?: string;
  readonly kind?: string;
  readonly accepted: boolean;
  readonly tick: number;
  readonly reasonCode?: string;
}

export interface MacroVerbInvokeResult {
  readonly accepted?: boolean;
  readonly reasonCode?: string;
  readonly receipt?: MacroReceiptTarget;
  readonly value?: MacroValue;
}

export interface MacroVerbDefinition {
  readonly verb: string;
  readonly kind: MacroVerbKind;
  readonly argSchema?: readonly MacroVerbArgSchema[];
  readonly execute?: (invocation: MacroVerbInvocation) => MacroVerbInvokeResult | void;
  readonly query?: (invocation: MacroVerbInvocation) => MacroValue;
}

export interface MacroVerbRegistry {
  resolve(verb: string): MacroVerbDefinition | null;
}

export type MacroRegistry = MacroVerbRegistry | VerbRegistry;

export type MacroRejectPolicy =
  | { readonly action: "halt" }
  | { readonly action: "continue" }
  | { readonly action: "goto"; readonly label: string };

export interface MacroSource {
  readonly name: string;
  readonly body: string;
  readonly iconId?: string;
}

export interface MacroLibraryEntry {
  readonly name: string;
  readonly iconId?: string;
  readonly bodyBytes?: number;
}

export interface MacroLibrary {
  getMacro(name: string): MacroSource | null;
  listMacros(): readonly MacroLibraryEntry[];
}

export interface MacroVariableScope {
  readonly runId: string;
  readonly macroName: string;
  readonly tick: number;
  readonly args: readonly MacroValue[];
  readonly last: MacroCommandReceipt | null;
}

export type MacroVariableResolver = (name: string, scope: MacroVariableScope) => MacroValue | undefined;

export interface MacroEngineOptions {
  readonly registry: MacroRegistry;
  readonly macros?: MacroLibrary | readonly MacroSource[];
  readonly caps?: MacroEngineCapOverrides;
  readonly variables?: Readonly<Record<string, MacroValue>>;
  readonly resolveVariable?: MacroVariableResolver;
}

export interface MacroStartRequest {
  readonly name: string;
  readonly body?: string;
  readonly args?: readonly MacroValue[];
  readonly iconId?: string;
}

export type MacroStartResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly reasonCode: string; readonly message?: string };

export type MacroRunStatus = "running" | "paused" | "waiting_receipt" | "waiting_until" | "yielded" | "completed" | "stopped" | "halted";

export interface MacroRunSnapshot {
  readonly runId: string;
  readonly name: string;
  readonly status: MacroRunStatus;
  readonly startedAtTick: number;
  readonly lastTick: number;
  readonly instructionPointer: number;
  readonly stackDepth: number;
  readonly jumpsUsed: number;
  readonly rejectPolicy: MacroRejectPolicy;
  readonly wait?: string;
  readonly lastReceipt: MacroCommandReceipt | null;
  readonly lastReasonCode?: string;
}

export interface MacroEngineState {
  readonly schema: "successor.macro-engine.state.v1";
  readonly tick: number;
  readonly caps: MacroEngineCaps;
  readonly activeRuns: readonly MacroRunSnapshot[];
  readonly completedRuns: readonly MacroRunSnapshot[];
  readonly macroLibrary: readonly MacroLibraryEntry[];
}

export interface MacroEngine {
  startMacro(request: MacroStartRequest): MacroStartResult;
  stopMacro(runIdOrName: string | "all"): number;
  listRuns(): readonly MacroRunSnapshot[];
  listMacros(): readonly MacroLibraryEntry[];
  getState(): MacroEngineState;
  tick(tick: number): MacroEngineState;
  ingestReceipt(receipt: MacroCommandReceipt): void;
  configureCaps(overrides: MacroEngineCapOverrides): MacroEngineCaps;
}
