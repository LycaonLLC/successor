/**
 * SURVEY register — the scanner's answers, spoken as bearings-to-richness.
 *
 * Input is a single surveyResult grid (the tool-gated store's newest disc)
 * plus the player position at scan time. We name the best reading and where
 * it lies; the numbers stay honest (concentration milli → %).
 */

import { bearingPhrase } from "../../game/bearing";
import { familyLabel } from "../copy";
import { pickVariant, type VoiceMemory } from "../voice";

export interface SurveyResultInputs {
  family: string;
  spawnName: string;
  centerX: number;
  centerY: number;
  rangeCells: number;
  stepCells: number;
  cols: number;
  rows: number;
  concentrationMilli: readonly number[];
  playerX: number;
  playerY: number;
}

export function composeSurveyLine(result: SurveyResultInputs, memory: VoiceMemory, seed: number): string {
  const best = bestCell(result);
  const family = familyLabel(result.family);
  if (!best || best.milli <= 0) {
    return pickVariant(memory, "survey:empty", [
      `The scanner sweeps ${result.rangeCells} cells and comes back empty — no ${family} worth the name here.`,
      `Flat reading. Whatever ${family} this ground holds, it is not within ${result.rangeCells} cells.`,
    ], seed);
  }
  const pct = Math.round(best.milli / 10);
  const dx = best.x - result.playerX;
  const dy = best.y - result.playerY;
  const where = Math.hypot(dx, dy) < 2 ? "right where you stand" : bearingPhrase(dx, dy);
  const vein = result.spawnName ? `${result.spawnName} ${family}` : family;
  return pickVariant(memory, "survey:hit", [
    `The scanner paints ${vein} strongest ${where} — ${pct}% at the peak.`,
    `Reading lands: ${vein}, ${pct}% concentration, ${where}.`,
    `The grid lights up ${where}: ${vein} at ${pct}%.`,
  ], seed);
}

export function bestCell(result: SurveyResultInputs): { x: number; y: number; milli: number } | null {
  let best: { x: number; y: number; milli: number } | null = null;
  for (let j = 0; j < result.rows; j += 1) {
    for (let i = 0; i < result.cols; i += 1) {
      const milli = result.concentrationMilli[j * result.cols + i] ?? 0;
      if (best && milli <= best.milli) continue;
      const x = result.centerX + (i - (result.cols - 1) / 2) * result.stepCells;
      const y = result.centerY + (j - (result.rows - 1) / 2) * result.stepCells;
      if (Math.hypot(x - result.centerX, y - result.centerY) > result.rangeCells) continue;
      best = { x, y, milli };
    }
  }
  return best;
}

export interface SampleOutcome {
  family: string;
  quantity: number | null;
  itemLabel: string | null;
}

export function composeSampleLine(outcome: SampleOutcome, memory: VoiceMemory, seed: number): string {
  const family = familyLabel(outcome.family);
  const what = outcome.itemLabel ?? family;
  const qty = outcome.quantity && outcome.quantity > 1 ? ` ×${outcome.quantity}` : "";
  return pickVariant(memory, "sample:hit", [
    `The sampler comes up heavy — ${what}${qty}.`,
    `You pull ${what}${qty} out of the ground.`,
    `Pay dirt: ${what}${qty}.`,
  ], seed);
}
