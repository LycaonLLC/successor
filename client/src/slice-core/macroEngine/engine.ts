import { macroEngineCaps, type MacroEngineCapOverrides, type MacroEngineCaps } from "./constants";
import { MacroParseError, parseMacroBody, utf8ByteLength, type MacroParsedArg, type MacroProgram, type MacroStatement, type MacroUntilPredicate, type MacroValueToken } from "./parser";
import type { VerbExecutionResult, VerbRegistryEntry } from "../verbRegistry";
import type {
  MacroCommandReceipt,
  MacroEngine,
  MacroEngineOptions,
  MacroEngineState,
  MacroInvocationArg,
  MacroLibrary,
  MacroLibraryEntry,
  MacroReceiptTarget,
  MacroRejectPolicy,
  MacroRunSnapshot,
  MacroScalar,
  MacroSource,
  MacroStartRequest,
  MacroStartResult,
  MacroValue,
  MacroVerbDefinition,
  MacroVerbInvokeResult,
  MacroVerbRegistry,
  MacroVerbInvocation,
} from "./types";

interface RuntimeFrame {
  readonly macroName: string;
  readonly program: MacroProgram;
  readonly args: MacroValue[];
  ip: number;
  readonly loopStates: Map<number, LoopState>;
}

interface LoopState {
  remaining: number | "forever";
}

type RuntimeWait =
  | { readonly type: "pause"; readonly untilTick: number }
  | { readonly type: "tick-yield"; readonly untilTick: number }
  | { readonly type: "receipt"; readonly target: MacroReceiptTarget; readonly timeoutTick?: number }
  | { readonly type: "until"; readonly predicate: MacroUntilPredicate; readonly timeoutTick?: number };

interface RuntimeRun {
  readonly runId: string;
  readonly name: string;
  readonly startedAtTick: number;
  lastTick: number;
  status: MacroRunSnapshot["status"];
  readonly frames: RuntimeFrame[];
  wait: RuntimeWait | null;
  rejectPolicy: MacroRejectPolicy;
  jumpsUsed: number;
  guardTick: number;
  statementsThisTick: number;
  loopIterationsThisTick: number;
  lastReceipt: MacroCommandReceipt | null;
  lastAuthorityReceiptTarget: MacroReceiptTarget | null;
  lastReasonCode?: string;
}

export function createMacroEngine(options: MacroEngineOptions): MacroEngine {
  let caps = macroEngineCaps(options.caps);
  const registry = normalizeRegistry(options.registry);
  const library = normalizeLibrary(options.macros ?? []);
  const activeRuns = new Map<string, RuntimeRun>();
  const completedRuns: MacroRunSnapshot[] = [];
  const receiptLog: MacroCommandReceipt[] = [];
  let lastTick = 0;
  let nextRunId = 1;

  const engine: MacroEngine = {
    startMacro(request: MacroStartRequest): MacroStartResult {
      if (activeRuns.size >= caps.runSlots) {
        return { ok: false, reasonCode: "macro_run_slots_exhausted" };
      }
      const source = request.body === undefined
        ? library.getMacro(request.name)
        : { name: request.name, body: request.body, iconId: request.iconId };
      if (!source) return { ok: false, reasonCode: "macro_not_found", message: request.name };
      if (utf8ByteLength(source.body) > caps.bodyBytes) {
        return { ok: false, reasonCode: "macro_body_too_large" };
      }
      let program: MacroProgram;
      try {
        program = parseMacroBody(source.body, { caps });
      } catch (error) {
        if (error instanceof MacroParseError) return { ok: false, reasonCode: error.code, message: error.message };
        throw error;
      }
      const runId = `macro:${nextRunId}`;
      nextRunId += 1;
      const args = [...(request.args ?? [])].slice(0, 9);
      activeRuns.set(runId, {
        runId,
        name: source.name,
        startedAtTick: lastTick,
        lastTick,
        status: "running",
        frames: [{ macroName: source.name, program, args, ip: 0, loopStates: new Map() }],
        wait: null,
        rejectPolicy: { action: "halt" },
        jumpsUsed: 0,
        guardTick: Number.NaN,
        statementsThisTick: 0,
        loopIterationsThisTick: 0,
        lastReceipt: null,
        lastAuthorityReceiptTarget: null,
      });
      return { ok: true, runId };
    },

    stopMacro(runIdOrName: string | "all"): number {
      const targets: RuntimeRun[] = [];
      for (const run of activeRuns.values()) {
        if (runIdOrName === "all" || run.runId === runIdOrName || run.name === runIdOrName) targets.push(run);
      }
      for (const run of targets) finishRun(run, "stopped", "macro_stopped");
      return targets.length;
    },

    listRuns(): readonly MacroRunSnapshot[] {
      return [...activeRuns.values()].map(snapshotRun);
    },

    listMacros(): readonly MacroLibraryEntry[] {
      return library.listMacros();
    },

    getState(): MacroEngineState {
      return stateSnapshot();
    },

    tick(tick: number): MacroEngineState {
      lastTick = Math.max(0, Math.trunc(tick));
      for (const run of [...activeRuns.values()]) advanceRun(run, lastTick);
      return stateSnapshot();
    },

    ingestReceipt(receipt: MacroCommandReceipt): void {
      const normalized = {
        ...receipt,
        tick: Math.max(0, Math.trunc(receipt.tick)),
      };
      receiptLog.push(normalized);
      while (receiptLog.length > caps.receiptLogEntries) receiptLog.shift();
    },

    configureCaps(overrides: MacroEngineCapOverrides): MacroEngineCaps {
      caps = macroEngineCaps({ ...caps, ...overrides });
      return caps;
    },
  };

  function stateSnapshot(): MacroEngineState {
    return {
      schema: "successor.macro-engine.state.v1",
      tick: lastTick,
      caps,
      activeRuns: [...activeRuns.values()].map(snapshotRun),
      completedRuns: [...completedRuns],
      macroLibrary: library.listMacros(),
    };
  }

  function advanceRun(run: RuntimeRun, tick: number): void {
    if (!activeRuns.has(run.runId)) return;
    run.lastTick = tick;
    if (run.guardTick !== tick) {
      run.guardTick = tick;
      run.statementsThisTick = 0;
      run.loopIterationsThisTick = 0;
    }

    while (activeRuns.has(run.runId)) {
      if (run.wait) {
        if (!advanceWait(run, tick)) return;
      }
      const frame = currentFrame(run);
      if (!frame) {
        finishRun(run, "completed");
        return;
      }
      if (frame.ip >= frame.program.statements.length) {
        run.frames.pop();
        continue;
      }
      if (run.statementsThisTick >= caps.statementsPerTick) {
        run.wait = { type: "tick-yield", untilTick: tick + 1 };
        run.status = "yielded";
        return;
      }
      const statement = frame.program.statements[frame.ip];
      if (!statement) {
        frame.ip += 1;
        continue;
      }
      run.statementsThisTick += 1;
      executeStatement(run, frame, statement, tick);
      if (run.wait) return;
    }
  }

  function advanceWait(run: RuntimeRun, tick: number): boolean {
    const wait = run.wait;
    if (!wait) return true;
    if (wait.type === "pause" || wait.type === "tick-yield") {
      if (tick < wait.untilTick) {
        run.status = wait.type === "pause" ? "paused" : "yielded";
        return false;
      }
      run.wait = null;
      run.status = "running";
      return true;
    }
    if (wait.type === "receipt") {
      const receipt = findReceipt(wait.target);
      if (receipt) {
        run.wait = null;
        finishWaitReceipt(run, receipt, tick);
        return true;
      }
      if (wait.timeoutTick !== undefined && tick >= wait.timeoutTick) {
        run.wait = null;
        const timedOut: MacroCommandReceipt = { accepted: false, tick, reasonCode: "waitreceipt_timeout" };
        finishWaitReceipt(run, timedOut, tick);
        return true;
      }
      run.status = "waiting_receipt";
      return false;
    }
    const predicate = evaluateUntilPredicate(run, wait.predicate, tick);
    if (predicate.accepted) {
      run.wait = null;
      const frame = currentFrame(run);
      if (frame) frame.ip += 1;
      run.status = "running";
      return true;
    }
    if (wait.timeoutTick !== undefined && tick >= wait.timeoutTick) {
      run.wait = null;
      applyReject(run, "until_timeout", tick);
      return true;
    }
    run.status = "waiting_until";
    return false;
  }

  function executeStatement(run: RuntimeRun, frame: RuntimeFrame, statement: MacroStatement, tick: number): void {
    switch (statement.type) {
      case "label":
        frame.ip += 1;
        return;
      case "pause": {
        const waitTicks = secondsToTicks(statement.seconds);
        if (waitTicks === 0) {
          frame.ip += 1;
          return;
        }
        frame.ip += 1;
        run.wait = { type: "pause", untilTick: tick + waitTicks };
        run.status = "paused";
        return;
      }
      case "onreject":
        run.rejectPolicy = statement.policy === "goto"
          ? { action: "goto", label: statement.label ?? "" }
          : { action: statement.policy };
        frame.ip += 1;
        return;
      case "goto":
        jumpToLabel(run, frame, statement.label, tick);
        return;
      case "dump":
        for (const candidate of [...activeRuns.values()]) finishRun(candidate, "stopped", "macro_dumped");
        return;
      case "waitreceipt":
        enterWaitReceipt(run, frame, statement.timeoutSeconds, tick);
        return;
      case "until":
        enterUntil(run, frame, statement.predicate, statement.timeoutSeconds, tick);
        return;
      case "macro":
        executeMacroControl(run, frame, statement, tick);
        return;
      case "loopStart":
        enterLoop(run, frame, statement, tick);
        return;
      case "loopEnd":
        leaveLoop(run, frame, statement, tick);
        return;
      case "verb":
        executeVerb(run, frame, statement, tick);
        return;
    }
  }

  function executeVerb(run: RuntimeRun, frame: RuntimeFrame, statement: Extract<MacroStatement, { type: "verb" }>, tick: number): void {
    const definition = registry.resolve(statement.verb);
    if (!definition) {
      applyReject(run, "unknown_verb", tick);
      return;
    }
    const resolved = resolveArgs(run, frame, statement.args, tick);
    if (!resolved.ok) {
      applyReject(run, resolved.reasonCode, tick);
      return;
    }
    const invocation = invocationFor(run, frame, definition, statement.verb, resolved.args, tick);
    if (definition.kind === "query") {
      if (!definition.query) {
        applyReject(run, "query_not_callable", tick);
        return;
      }
      definition.query(invocation);
      frame.ip += 1;
      return;
    }
    if (!definition.execute) {
      applyReject(run, "verb_not_executable", tick);
      return;
    }
    const result = definition.execute(invocation) ?? { accepted: true };
    const accepted = result.accepted !== false;
    if (definition.kind === "authority") {
      run.lastAuthorityReceiptTarget = result.receipt ?? { kind: definition.verb };
    }
    if (!accepted) {
      applyReject(run, result.reasonCode ?? "verb_rejected", tick);
      return;
    }
    frame.ip += 1;
  }

  function enterWaitReceipt(run: RuntimeRun, frame: RuntimeFrame, timeoutSeconds: number | undefined, tick: number): void {
    const target = run.lastAuthorityReceiptTarget;
    if (!target) {
      applyReject(run, "missing_receipt_target", tick);
      return;
    }
    const receipt = findReceipt(target);
    if (receipt) {
      finishWaitReceipt(run, receipt, tick);
      return;
    }
    run.wait = {
      type: "receipt",
      target,
      timeoutTick: timeoutSeconds === undefined ? undefined : tick + secondsToTicks(timeoutSeconds),
    };
    run.status = "waiting_receipt";
  }

  function finishWaitReceipt(run: RuntimeRun, receipt: MacroCommandReceipt, tick: number): void {
    run.lastReceipt = receipt;
    run.lastReasonCode = receipt.reasonCode;
    if (!receipt.accepted) {
      applyReject(run, receipt.reasonCode ?? "receipt_rejected", tick);
      return;
    }
    const frame = currentFrame(run);
    if (frame) frame.ip += 1;
    run.status = "running";
  }

  function enterUntil(run: RuntimeRun, frame: RuntimeFrame, predicate: MacroUntilPredicate, timeoutSeconds: number | undefined, tick: number): void {
    const result = evaluateUntilPredicate(run, predicate, tick);
    if (result.accepted) {
      frame.ip += 1;
      return;
    }
    if (result.reasonCode) {
      applyReject(run, result.reasonCode, tick);
      return;
    }
    run.wait = {
      type: "until",
      predicate,
      timeoutTick: timeoutSeconds === undefined ? undefined : tick + secondsToTicks(timeoutSeconds),
    };
    run.status = "waiting_until";
  }

  function evaluateUntilPredicate(run: RuntimeRun, predicate: MacroUntilPredicate, tick: number): { accepted: boolean; reasonCode?: string } {
    const definition = registry.resolve(predicate.queryVerb);
    if (!definition) return { accepted: false, reasonCode: "unknown_query_verb" };
    if (definition.kind !== "query" || !definition.query) return { accepted: false, reasonCode: "not_query_verb" };
    const frame = currentFrame(run);
    if (!frame) return { accepted: false, reasonCode: "macro_not_running" };
    const invocation = invocationFor(run, frame, definition, predicate.queryVerb, [], tick);
    const queried = definition.query(invocation);
    const actual = valueAtPath(queried, predicate.fieldPath);
    if (predicate.operator === "truthy") return { accepted: Boolean(actual) };
    if (!predicate.expected) return { accepted: false, reasonCode: "bad_until_predicate" };
    const expected = resolveValue(run, frame, predicate.expected, tick);
    if (!expected.ok) return { accepted: false, reasonCode: expected.reasonCode };
    return { accepted: compareValues(actual, expected.value, predicate.operator) };
  }

  function executeMacroControl(run: RuntimeRun, frame: RuntimeFrame, statement: Extract<MacroStatement, { type: "macro" }>, tick: number): void {
    if (statement.action === "list") {
      library.listMacros();
      frame.ip += 1;
      return;
    }
    if (statement.action === "stop") {
      const name = statement.name ?? "";
      if (name === "all") {
        for (const candidate of [...activeRuns.values()]) finishRun(candidate, "stopped", "macro_stopped");
        return;
      }
      let stopped = 0;
      for (const candidate of [...activeRuns.values()]) {
        if (candidate.name === name || candidate.runId === name) {
          finishRun(candidate, "stopped", "macro_stopped");
          stopped += 1;
        }
      }
      if (stopped === 0) applyReject(run, "macro_not_found", tick);
      else if (activeRuns.has(run.runId)) frame.ip += 1;
      return;
    }
    const name = statement.name ?? "";
    if (run.frames.length >= Math.min(caps.recursionDepth, caps.chainDepth)) {
      applyReject(run, "macro_depth_exceeded", tick);
      return;
    }
    const source = library.getMacro(name);
    if (!source) {
      applyReject(run, "macro_not_found", tick);
      return;
    }
    let program: MacroProgram;
    try {
      program = parseMacroBody(source.body, { caps });
    } catch (error) {
      if (error instanceof MacroParseError) {
        applyReject(run, error.code, tick);
        return;
      }
      throw error;
    }
    const resolvedArgs = resolveArgs(run, frame, statement.args, tick);
    if (!resolvedArgs.ok) {
      applyReject(run, resolvedArgs.reasonCode, tick);
      return;
    }
    frame.ip += 1;
    run.frames.push({
      macroName: source.name,
      program,
      args: resolvedArgs.args.map((arg) => arg.value).slice(0, 9),
      ip: 0,
      loopStates: new Map(),
    });
  }

  function enterLoop(run: RuntimeRun, frame: RuntimeFrame, statement: Extract<MacroStatement, { type: "loopStart" }>, tick: number): void {
    let loop = frame.loopStates.get(frame.ip);
    if (!loop) {
      loop = { remaining: statement.count };
      frame.loopStates.set(frame.ip, loop);
    }
    if (!guardLoopIteration(run, tick)) return;
    frame.ip += 1;
  }

  function leaveLoop(run: RuntimeRun, frame: RuntimeFrame, statement: Extract<MacroStatement, { type: "loopEnd" }>, tick: number): void {
    const loop = frame.loopStates.get(statement.startIndex);
    if (!loop) {
      frame.ip += 1;
      return;
    }
    if (loop.remaining === "forever" || loop.remaining > 1) {
      if (!countJump(run, tick)) return;
      if (loop.remaining !== "forever") loop.remaining -= 1;
      frame.ip = statement.startIndex;
      return;
    }
    frame.loopStates.delete(statement.startIndex);
    frame.ip += 1;
  }

  function jumpToLabel(run: RuntimeRun, frame: RuntimeFrame, label: string, tick: number): void {
    const destination = frame.program.labels[label];
    if (destination === undefined) {
      finishRun(run, "halted", "unknown_label");
      return;
    }
    if (!countJump(run, tick)) return;
    frame.ip = destination + 1;
    for (const [startIndex, loop] of frame.loopStates) {
      const loopStart = frame.program.statements[startIndex];
      if (loopStart?.type !== "loopStart") {
        frame.loopStates.delete(startIndex);
        continue;
      }
      const insideLoop = destination > startIndex && destination < loopStart.endIndex;
      if (!insideLoop || loop.remaining !== "forever") frame.loopStates.delete(startIndex);
    }
  }

  function applyReject(run: RuntimeRun, reasonCode: string, tick: number): void {
    run.lastReceipt = { accepted: false, tick, reasonCode };
    run.lastReasonCode = reasonCode;
    const frame = currentFrame(run);
    if (!frame) {
      finishRun(run, "halted", reasonCode);
      return;
    }
    if (run.rejectPolicy.action === "continue") {
      frame.ip += 1;
      run.status = "running";
      return;
    }
    if (run.rejectPolicy.action === "goto") {
      jumpToLabel(run, frame, run.rejectPolicy.label, tick);
      return;
    }
    finishRun(run, "halted", reasonCode);
  }

  function countJump(run: RuntimeRun, _tick: number): boolean {
    run.jumpsUsed += 1;
    if (run.jumpsUsed > caps.jumpsPerRun) {
      finishRun(run, "halted", "macro_jump_cap_exceeded");
      return false;
    }
    return true;
  }

  function guardLoopIteration(run: RuntimeRun, tick: number): boolean {
    if (run.loopIterationsThisTick >= caps.loopIterationsPerTick) {
      run.wait = { type: "tick-yield", untilTick: tick + 1 };
      run.status = "yielded";
      return false;
    }
    run.loopIterationsThisTick += 1;
    return true;
  }

  function resolveArgs(run: RuntimeRun, frame: RuntimeFrame, args: readonly MacroParsedArg[], tick: number): { ok: true; args: MacroInvocationArg[] } | { ok: false; reasonCode: string } {
    const resolved: MacroInvocationArg[] = [];
    for (const arg of args) {
      const value = resolveValue(run, frame, arg.value, tick);
      if (!value.ok) return { ok: false, reasonCode: value.reasonCode };
      resolved.push(arg.key === undefined
        ? { value: value.value, raw: arg.raw }
        : { key: arg.key, value: value.value, raw: arg.raw });
    }
    return { ok: true, args: resolved };
  }

  function resolveValue(run: RuntimeRun, frame: RuntimeFrame, value: MacroValueToken, tick: number): { ok: true; value: MacroValue } | { ok: false; reasonCode: string } {
    if (value.kind === "number" || value.kind === "string" || value.kind === "id") return { ok: true, value: value.value };
    const [root, ...fields] = value.path;
    if (!root) return { ok: false, reasonCode: "variable_unresolved" };
    let resolved: MacroValue | undefined;
    if (/^[1-9]$/u.test(root)) {
      resolved = frame.args[Number.parseInt(root, 10) - 1];
    } else if (root === "last") {
      resolved = run.lastReceipt as unknown as MacroValue;
    } else if (options.variables && Object.prototype.hasOwnProperty.call(options.variables, root)) {
      resolved = options.variables[root];
    } else if (options.resolveVariable) {
      resolved = options.resolveVariable(root, {
        runId: run.runId,
        macroName: frame.macroName,
        tick,
        args: frame.args,
        last: run.lastReceipt,
      });
    }
    if (resolved === undefined || resolved === null && fields.length > 0) return { ok: false, reasonCode: "variable_unresolved" };
    const nested = valueAtPath(resolved ?? null, fields);
    if (nested === undefined) return { ok: false, reasonCode: "variable_unresolved" };
    return { ok: true, value: nested };
  }

  function invocationFor(run: RuntimeRun, frame: RuntimeFrame, definition: MacroVerbDefinition, verb: string, args: readonly MacroInvocationArg[], tick: number): MacroVerbInvocation {
    const positional: MacroValue[] = [];
    const named: Record<string, MacroValue> = {};
    for (const arg of args) {
      if (arg.key === undefined) positional.push(arg.value);
      else named[arg.key] = arg.value;
    }
    return {
      runId: run.runId,
      macroName: frame.macroName,
      verb,
      kind: definition.kind,
      tick,
      depth: run.frames.length,
      args,
      positional,
      named,
    };
  }

  function finishRun(run: RuntimeRun, status: "completed" | "stopped" | "halted", reasonCode?: string): void {
    if (!activeRuns.has(run.runId)) return;
    run.status = status;
    if (reasonCode) run.lastReasonCode = reasonCode;
    activeRuns.delete(run.runId);
    completedRuns.push(snapshotRun(run));
    while (completedRuns.length > 64) completedRuns.shift();
  }

  function findReceipt(target: MacroReceiptTarget): MacroCommandReceipt | null {
    for (let index = receiptLog.length - 1; index >= 0; index -= 1) {
      const receipt = receiptLog[index];
      if (!receipt) continue;
      if (target.token !== undefined && receipt.token === target.token) return receipt;
      const receiptCommandId = receipt.commandId ?? receipt.command_id;
      if (target.commandId !== undefined && receiptCommandId !== undefined && String(receiptCommandId) === String(target.commandId)) return receipt;
      if (target.token === undefined && target.commandId === undefined && target.kind !== undefined && receipt.kind === target.kind) return receipt;
    }
    return null;
  }

  function secondsToTicks(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.max(0, Math.ceil(seconds * caps.tickRateHz));
  }

  function currentFrame(run: RuntimeRun): RuntimeFrame | null {
    return run.frames.at(-1) ?? null;
  }

  return engine;
}

function normalizeRegistry(registry: MacroEngineOptions["registry"]): MacroVerbRegistry {
  const cache = new Map<string, MacroVerbDefinition>();
  return {
    resolve(verb: string): MacroVerbDefinition | null {
      const cached = cache.get(verb);
      if (cached) return cached;
      const entry = registry.resolve(verb) as MacroVerbDefinition | VerbRegistryEntry | null;
      if (!entry) return null;
      const definition = isVerbRegistryEntry(entry) ? macroDefinitionFromVerbEntry(entry) : entry;
      cache.set(verb, definition);
      return definition;
    },
  };
}

function isVerbRegistryEntry(entry: MacroVerbDefinition | VerbRegistryEntry): entry is VerbRegistryEntry {
  return "class" in entry;
}

function macroDefinitionFromVerbEntry(entry: VerbRegistryEntry): MacroVerbDefinition {
  return {
    verb: entry.verb,
    kind: entry.class,
    argSchema: entry.argSchema,
    execute(invocation: MacroVerbInvocation): MacroVerbInvokeResult {
      const result = entry.execute(verbArgsFromInvocation(invocation), { invokedVerb: invocation.verb, rawLine: null });
      return macroInvokeResultFromVerbResult(entry, result);
    },
    query(invocation: MacroVerbInvocation): MacroValue {
      const result = entry.execute(verbArgsFromInvocation(invocation), { invokedVerb: invocation.verb, rawLine: null });
      return macroValueFromUnknown(result.data);
    },
  };
}

function verbArgsFromInvocation(invocation: MacroVerbInvocation): string[] {
  return invocation.args.map((arg) => {
    const value = macroValueToToken(arg.value);
    return arg.key === undefined ? value : `${arg.key}=${value}`;
  });
}

function macroInvokeResultFromVerbResult(entry: VerbRegistryEntry, result: VerbExecutionResult): MacroVerbInvokeResult {
  if (result.class === "authority") {
    const data = result.data;
    const error = typeof data.error === "string" ? data.error : undefined;
    const queued = data.queued === true;
    const commandId = typeof data.commandId === "number" || typeof data.commandId === "string" ? data.commandId : undefined;
    return {
      accepted: queued && !error,
      reasonCode: error ?? (queued ? undefined : "verb_rejected"),
      receipt: commandId === undefined
        ? { kind: typeof data.commandKind === "string" ? data.commandKind : entry.commandKind ?? entry.verb }
        : { commandId, kind: typeof data.commandKind === "string" ? data.commandKind : entry.commandKind ?? entry.verb },
      value: macroValueFromUnknown(data),
    };
  }
  if (result.class === "local") {
    const data = result.data;
    const ok = data.ok !== false;
    return {
      accepted: ok,
      reasonCode: ok ? undefined : (typeof data.error === "string" ? data.error : `${entry.verb}_rejected`),
      value: macroValueFromUnknown(data),
    };
  }
  return { accepted: true, value: macroValueFromUnknown(result.data) };
}

function macroValueToToken(value: MacroValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function macroValueFromUnknown(value: unknown): MacroValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((entry) => macroValueFromUnknown(entry));
  if (typeof value === "object" && value !== null) {
    const output: Record<string, MacroValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) output[key] = macroValueFromUnknown(entry);
    }
    return output;
  }
  return String(value);
}

function normalizeLibrary(input: MacroLibrary | readonly MacroSource[]): MacroLibrary {
  if (isMacroLibrary(input)) return input;
  const macros = new Map<string, MacroSource>();
  for (const macro of input) macros.set(macro.name, macro);
  return {
    getMacro(name: string): MacroSource | null {
      return macros.get(name) ?? null;
    },
    listMacros(): readonly MacroLibraryEntry[] {
      return [...macros.values()].map((macro) => ({
        name: macro.name,
        iconId: macro.iconId,
        bodyBytes: utf8ByteLength(macro.body),
      }));
    },
  };
}

function isMacroLibrary(input: MacroLibrary | readonly MacroSource[]): input is MacroLibrary {
  return typeof (input as MacroLibrary).getMacro === "function" && typeof (input as MacroLibrary).listMacros === "function";
}

function snapshotRun(run: RuntimeRun): MacroRunSnapshot {
  const frame = run.frames.at(-1);
  const wait = run.wait ? waitLabel(run.wait) : undefined;
  return {
    runId: run.runId,
    name: run.name,
    status: run.status,
    startedAtTick: run.startedAtTick,
    lastTick: run.lastTick,
    instructionPointer: frame?.ip ?? 0,
    stackDepth: run.frames.length,
    jumpsUsed: run.jumpsUsed,
    rejectPolicy: run.rejectPolicy,
    wait,
    lastReceipt: run.lastReceipt,
    lastReasonCode: run.lastReasonCode,
  };
}

function waitLabel(wait: RuntimeWait): string {
  switch (wait.type) {
    case "pause":
      return `pause:${wait.untilTick}`;
    case "tick-yield":
      return `yield:${wait.untilTick}`;
    case "receipt":
      return "receipt";
    case "until":
      return `until:${wait.predicate.queryVerb}`;
  }
}

function valueAtPath(value: MacroValue, path: readonly string[]): MacroValue | undefined {
  let current: MacroValue | undefined = value;
  for (const field of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[field];
  }
  return current;
}

function compareValues(actual: MacroValue | undefined, expected: MacroValue, operator: Exclude<MacroUntilPredicate["operator"], "truthy">): boolean {
  if (operator === "==") return scalarForCompare(actual) === scalarForCompare(expected);
  if (operator === "!=") return scalarForCompare(actual) !== scalarForCompare(expected);
  const left = numericForCompare(actual);
  const right = numericForCompare(expected);
  if (left === null || right === null) return false;
  if (operator === ">=") return left >= right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  return left < right;
}

function scalarForCompare(value: MacroValue | undefined): MacroScalar | undefined {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function numericForCompare(value: MacroValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}
