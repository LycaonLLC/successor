export interface MacroEngineCaps {
  readonly bodyBytes: number;
  readonly recursionDepth: number;
  readonly chainDepth: number;
  readonly jumpsPerRun: number;
  readonly loopIterationsPerTick: number;
  readonly statementsPerTick: number;
  readonly macrosPerCharacter: number;
  readonly runSlots: number;
  readonly tickRateHz: number;
  readonly receiptLogEntries: number;
}

export const MACRO_ENGINE_DEFAULT_CAPS: MacroEngineCaps = Object.freeze({
  bodyBytes: 8 * 1024,
  recursionDepth: 8,
  chainDepth: 8,
  jumpsPerRun: 1024,
  loopIterationsPerTick: 64,
  statementsPerTick: 256,
  macrosPerCharacter: 64,
  runSlots: 4,
  tickRateHz: 30,
  receiptLogEntries: 128,
});

export type MacroEngineCapOverrides = Partial<MacroEngineCaps>;

export function macroEngineCaps(overrides: MacroEngineCapOverrides = {}): MacroEngineCaps {
  return Object.freeze({
    bodyBytes: positiveInteger(overrides.bodyBytes, MACRO_ENGINE_DEFAULT_CAPS.bodyBytes),
    recursionDepth: positiveInteger(overrides.recursionDepth, MACRO_ENGINE_DEFAULT_CAPS.recursionDepth),
    chainDepth: positiveInteger(overrides.chainDepth, MACRO_ENGINE_DEFAULT_CAPS.chainDepth),
    jumpsPerRun: positiveInteger(overrides.jumpsPerRun, MACRO_ENGINE_DEFAULT_CAPS.jumpsPerRun),
    loopIterationsPerTick: positiveInteger(overrides.loopIterationsPerTick, MACRO_ENGINE_DEFAULT_CAPS.loopIterationsPerTick),
    statementsPerTick: positiveInteger(overrides.statementsPerTick, MACRO_ENGINE_DEFAULT_CAPS.statementsPerTick),
    macrosPerCharacter: positiveInteger(overrides.macrosPerCharacter, MACRO_ENGINE_DEFAULT_CAPS.macrosPerCharacter),
    runSlots: positiveInteger(overrides.runSlots, MACRO_ENGINE_DEFAULT_CAPS.runSlots),
    tickRateHz: positiveInteger(overrides.tickRateHz, MACRO_ENGINE_DEFAULT_CAPS.tickRateHz),
    receiptLogEntries: positiveInteger(overrides.receiptLogEntries, MACRO_ENGINE_DEFAULT_CAPS.receiptLogEntries),
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}
