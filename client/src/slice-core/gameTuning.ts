import tuningSpecPayload from "./specs/tuning.v1.json";

interface SliceTuningSpec {
  schema: "successor.slice-tuning.v1";
  movement: {
    playerSpeedCellsPerSecond: number;
    sprintSpeedMultiplier: number;
    sprintActionDrainPerSecond: number;
  };
  spatialChat: {
    minTtlMs: number;
    maxTtlMs: number;
    msPerChar: number;
    fadeInMs: number;
    fadeOutMs: number;
    maxStack: number;
  };
}

const tuning = parseSliceTuning(tuningSpecPayload);

export const playerSpeedCellsPerSecond = tuning.movement.playerSpeedCellsPerSecond;
export const sprintSpeedMultiplier = tuning.movement.sprintSpeedMultiplier;
export const sprintActionDrainPerSecond = tuning.movement.sprintActionDrainPerSecond;
export const spatialBubbleMinTtlMs = tuning.spatialChat.minTtlMs;
export const spatialBubbleMaxTtlMs = tuning.spatialChat.maxTtlMs;
export const spatialBubbleMsPerChar = tuning.spatialChat.msPerChar;
export const spatialBubbleFadeInMs = tuning.spatialChat.fadeInMs;
export const spatialBubbleFadeOutMs = tuning.spatialChat.fadeOutMs;
export const spatialBubbleMaxStack = tuning.spatialChat.maxStack;

function parseSliceTuning(payload: unknown): SliceTuningSpec {
  const parsed = payload as Partial<SliceTuningSpec>;
  if (parsed.schema !== "successor.slice-tuning.v1") {
    throw new Error("slice-core tuning schema mismatch");
  }
  if (!parsed.movement || !parsed.spatialChat) {
    throw new Error("slice-core tuning missing section");
  }
  assertPositive(parsed.movement.playerSpeedCellsPerSecond, "playerSpeedCellsPerSecond");
  assertPositive(parsed.movement.sprintSpeedMultiplier, "sprintSpeedMultiplier");
  assertPositive(parsed.movement.sprintActionDrainPerSecond, "sprintActionDrainPerSecond");
  assertPositive(parsed.spatialChat.minTtlMs, "spatialChat.minTtlMs");
  assertPositive(parsed.spatialChat.maxTtlMs, "spatialChat.maxTtlMs");
  assertPositive(parsed.spatialChat.msPerChar, "spatialChat.msPerChar");
  assertPositive(parsed.spatialChat.fadeInMs, "spatialChat.fadeInMs");
  assertPositive(parsed.spatialChat.fadeOutMs, "spatialChat.fadeOutMs");
  assertPositive(parsed.spatialChat.maxStack, "spatialChat.maxStack");
  return parsed as SliceTuningSpec;
}

function assertPositive(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}
