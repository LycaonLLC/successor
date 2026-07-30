/**
 * Survey store — tool-gated knowledge, TUI edition.
 *
 * Fills ONLY from `surveyResult` messages (one per accepted SurveyResource
 * command — the same gate as the headed survey store). Discs are
 * world-anchored and accumulate per (areaId, family); newer discs occlude
 * fully-covered older ones. No scan, no knowledge — the visibility law.
 */

import type { ServerAuthoritySurveyResultState } from "@successor/client/src/slice-core/gameState";

export interface SurveyDisc {
  family: string;
  spawnId: string;
  spawnName: string;
  centerX: number;
  centerY: number;
  rangeCells: number;
  stepCells: number;
  cols: number;
  rows: number;
  values: readonly number[];
  scannedAtTick: number;
  cooldownUntilTick: number;
}

export interface SurveyStore {
  ingest(areaId: string, message: ServerAuthoritySurveyResultState): boolean;
  discsFor(areaId: string, family: string): readonly SurveyDisc[];
  latest(areaId: string, family: string): SurveyDisc | null;
  families(areaId: string): readonly string[];
  version(): number;
}

const MAX_DISCS_PER_KEY = 24;

export function createSurveyStore(): SurveyStore {
  const byKey = new Map<string, SurveyDisc[]>();
  let version = 0;

  return {
    ingest(areaId, message) {
      const valid = typeof message.family === "string"
        && message.family.length > 0
        && Number.isFinite(message.centerX)
        && Number.isFinite(message.centerY)
        && message.rangeCells > 0
        && message.stepCells > 0
        && Number.isInteger(message.cols)
        && Number.isInteger(message.rows)
        && message.cols > 1
        && message.rows > 1
        && Array.isArray(message.concentrationMilli)
        && message.concentrationMilli.length === message.cols * message.rows;
      if (!valid) return false;
      const key = `${areaId}\u0000${message.family}`;
      const disc: SurveyDisc = {
        family: message.family,
        spawnId: message.spawnId,
        spawnName: message.spawnName,
        centerX: message.centerX,
        centerY: message.centerY,
        rangeCells: message.rangeCells,
        stepCells: message.stepCells,
        cols: message.cols,
        rows: message.rows,
        values: message.concentrationMilli.slice(),
        scannedAtTick: message.tick,
        cooldownUntilTick: message.cooldownUntilTick,
      };
      const existing = byKey.get(key) ?? [];
      byKey.set(key, [disc, ...existing.filter((d) => !discCovers(disc, d))].slice(0, MAX_DISCS_PER_KEY));
      version += 1;
      return true;
    },
    discsFor(areaId, family) {
      return byKey.get(`${areaId}\u0000${family}`) ?? [];
    },
    latest(areaId, family) {
      return byKey.get(`${areaId}\u0000${family}`)?.[0] ?? null;
    },
    families(areaId) {
      const out: string[] = [];
      for (const key of byKey.keys()) {
        const [keyArea, family] = key.split("\u0000");
        if (keyArea === areaId && family) out.push(family);
      }
      return out;
    },
    version() {
      return version;
    },
  };
}

function discCovers(outer: SurveyDisc, inner: SurveyDisc): boolean {
  return Math.hypot(inner.centerX - outer.centerX, inner.centerY - outer.centerY) + inner.rangeCells <= outer.rangeCells;
}
