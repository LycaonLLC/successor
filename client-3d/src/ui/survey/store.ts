import type { ResourceCategory } from "@successor/client/src/slice-core/resourceCategories";
import {
  resourceCategoryForFamily,
  surveyFamilyForCategory,
} from "@successor/client/src/slice-core/resourceCategories";

/**
 * SURVEY store — client-side accumulation of world-anchored scan discs.
 *
 * The server answers each `SurveyResource` command with ONE `surveyResult`
 * grid (contract frozen with the sim lanes — see the survey tool window).
 * Scans are deliberately not streamed: one pull per SURVEY press, established sandbox-style,
 * so the network cost is a single small grid.
 *
 * Semantics (owner-ratified):
 *  - Disc data is WORLD-ANCHORED and STATIC: values are truth from scan
 *    time and never move with the player. Only the player blip is live.
 *  - Discs ACCUMULATE per (areaId, family) — surveying elsewhere paints
 *    more of the map; re-scanning newer data over old wins (painter's
 *    order, newest first on reads).
 *  - Unscanned map stays percent-less; the radar renders it as void.
 *
 * Module-level singleton mirroring the examine-window sink pattern (one
 * PlayState per page). Reset happens with the page, which matches shard
 * lifetime for the disposable fixtures.
 */

export interface SurveyResultMessage {
  family: string;
  spawnId: string;
  /** Generated spawn name, e.g. "Daxmire" — FE renders "%Name% - Iron". */
  spawnName: string;
  centerX: number;
  centerY: number;
  rangeCells: number;
  stepCells: number;
  cols: number;
  rows: number;
  /** Row-major cols×rows concentration milli (0–1000). */
  concentrationMilli: number[];
  cooldownUntilTick: number;
  tick: number;
}

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
  /** Row-major, 0–1000; index j*cols+i, i→+x, j→+y. */
  values: readonly number[];
  scannedAtTick: number;
}

export interface SurveyPulse {
  x: number;
  y: number;
  rangeCells: number;
}

/** Canonical registry families — the server canonicalizes survey responses to
 * these keys. Category survey-tool item ids live in the shared
 * resourceCategories model (mineral 3008 / chemical 3009 / gas 3010 / water 3011). */
export const IRON_FAMILY = "metal";
export const COPPER_FAMILY = "copper";

const SURVEY_FAMILY_ALIAS: Readonly<Record<string, string>> = {
  metal: IRON_FAMILY,
  iron: IRON_FAMILY,
  ferrite: IRON_FAMILY,
  mineral: IRON_FAMILY,
  minerals: IRON_FAMILY,
  ore: IRON_FAMILY,
  copper: COPPER_FAMILY,
  cuprite: COPPER_FAMILY,
  cu: COPPER_FAMILY,
  conductor: COPPER_FAMILY,
  chemical: "chemical",
  chemicals: "chemical",
  chem: "chemical",
  petro: "chemical",
  petroleum: "chemical",
  solvent: "chemical",
  catalyst: "chemical",
  binder: "chemical",
  gas: "gas",
  gasses: "gas",
  gases: "gas",
  gaseous: "gas",
  vapor: "gas",
  fuelgas: "gas",
  water: "water",
  liquid: "water",
  liquids: "water",
  moisture: "water",
  aqua: "water",
  h2o: "water",
  hydro: "water",
};

export function canonicalSurveyFamily(value: string | null | undefined): string {
  const key = value?.trim().toLowerCase() ?? "";
  return key.length === 0
    ? IRON_FAMILY
    : Object.prototype.hasOwnProperty.call(SURVEY_FAMILY_ALIAS, key)
      ? SURVEY_FAMILY_ALIAS[key]!
      : key;
}

/** Newest-first disc list per (areaId, family). */
const MAX_DISCS_PER_KEY = 24;

interface SurveyKeyState {
  discs: SurveyDisc[];
  lastMessage: SurveyResultMessage;
}

const byKey = new Map<string, SurveyKeyState>();
const pulseQueue: SurveyPulse[] = [];
let storeVersion = 0;

function keyOf(areaId: string, family: string): string {
  return `${areaId}\u0000${family}`;
}

/** Monotonic counter bumped on every ingest — cheap repaint detection. */
export function surveyStoreVersion(): number {
  return storeVersion;
}

export function ingestSurveyResult(areaId: string, msg: SurveyResultMessage): boolean {
  const valid =
    typeof msg.family === "string" &&
    msg.family.length > 0 &&
    Number.isFinite(msg.centerX) &&
    Number.isFinite(msg.centerY) &&
    Number.isFinite(msg.rangeCells) &&
    msg.rangeCells > 0 &&
    Number.isFinite(msg.stepCells) &&
    msg.stepCells > 0 &&
    Number.isInteger(msg.cols) &&
    Number.isInteger(msg.rows) &&
    msg.cols > 1 &&
    msg.rows > 1 &&
    Array.isArray(msg.concentrationMilli) &&
    msg.concentrationMilli.length === msg.cols * msg.rows;
  if (!valid) return false;
  const key = keyOf(areaId, msg.family);
  let entry = byKey.get(key);
  if (!entry) {
    entry = { discs: [], lastMessage: msg };
    byKey.set(key, entry);
  }
  entry.lastMessage = msg;
  const disc: SurveyDisc = {
    family: msg.family,
    spawnId: msg.spawnId,
    spawnName: msg.spawnName,
    centerX: msg.centerX,
    centerY: msg.centerY,
    rangeCells: msg.rangeCells,
    stepCells: msg.stepCells,
    cols: msg.cols,
    rows: msg.rows,
    values: msg.concentrationMilli.slice(),
    scannedAtTick: msg.tick,
  };
  // Newest first. Drop older discs fully covered by this one (their data is
  // stale everywhere the new disc speaks), then cap total.
  entry.discs = [
    disc,
    ...entry.discs.filter((d) => !discCovers(disc, d)),
  ].slice(0, MAX_DISCS_PER_KEY);
  pulseQueue.push({ x: msg.centerX, y: msg.centerY, rangeCells: msg.rangeCells });
  storeVersion += 1;
  return true;
}

function discCovers(outer: SurveyDisc, inner: SurveyDisc): boolean {
  const dx = inner.centerX - outer.centerX;
  const dy = inner.centerY - outer.centerY;
  return Math.hypot(dx, dy) + inner.rangeCells <= outer.rangeCells;
}

export function surveyDiscsFor(areaId: string, family: string): readonly SurveyDisc[] {
  return byKey.get(keyOf(areaId, family))?.discs ?? [];
}

export function lastSurveyResultFor(
  areaId: string,
  family: string,
): SurveyResultMessage | null {
  return byKey.get(keyOf(areaId, family))?.lastMessage ?? null;
}

/**
 * Concentration milli at a world cell from the newest covering disc
 * (bilinear across the grid), or null where nothing has been scanned.
 * Coverage is circular — matches the radar's disc rendering.
 */
export function surveyConcentrationAt(
  areaId: string,
  family: string,
  x: number,
  y: number,
): number | null {
  const discs = surveyDiscsFor(areaId, family);
  for (const disc of discs) {
    const dx = x - disc.centerX;
    const dy = y - disc.centerY;
    if (Math.hypot(dx, dy) > disc.rangeCells) continue;
    return sampleDisc(disc, x, y);
  }
  return null;
}

function sampleDisc(disc: SurveyDisc, x: number, y: number): number {
  // Grid index (i, j) sits at world (centerX + (i - (cols-1)/2) * step, …).
  const fi = (x - disc.centerX) / disc.stepCells + (disc.cols - 1) / 2;
  const fj = (y - disc.centerY) / disc.stepCells + (disc.rows - 1) / 2;
  const i0 = Math.max(0, Math.min(disc.cols - 2, Math.floor(fi)));
  const j0 = Math.max(0, Math.min(disc.rows - 2, Math.floor(fj)));
  const tx = Math.max(0, Math.min(1, fi - i0));
  const ty = Math.max(0, Math.min(1, fj - j0));
  const v00 = disc.values[j0 * disc.cols + i0] ?? 0;
  const v10 = disc.values[j0 * disc.cols + i0 + 1] ?? 0;
  const v01 = disc.values[(j0 + 1) * disc.cols + i0] ?? 0;
  const v11 = disc.values[(j0 + 1) * disc.cols + i0 + 1] ?? 0;
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

/**
 * Richest KNOWN point for (areaId, family), or null. Newest data wins:
 * a point from an older disc is skipped when any newer disc covers that
 * world position — rescans repaint reality, the marker must never point
 * at stale readings.
 */
export function surveyRichestKnown(
  areaId: string,
  family: string,
): { x: number; y: number; milli: number } | null {
  const discs = surveyDiscsFor(areaId, family);
  let best: { x: number; y: number; milli: number } | null = null;
  for (let d = 0; d < discs.length; d++) {
    const disc = discs[d];
    if (!disc) continue;
    for (let j = 0; j < disc.rows; j++) {
      for (let i = 0; i < disc.cols; i++) {
        const milli = disc.values[j * disc.cols + i] ?? 0;
        if (best && milli <= best.milli) continue;
        const x = disc.centerX + (i - (disc.cols - 1) / 2) * disc.stepCells;
        const y = disc.centerY + (j - (disc.rows - 1) / 2) * disc.stepCells;
        if (Math.hypot(x - disc.centerX, y - disc.centerY) > disc.rangeCells) continue;
        // Occlusion: a NEWER disc (lower index) owns this world point.
        let occluded = false;
        for (let n = 0; n < d; n++) {
          const newer = discs[n];
          if (!newer) continue;
          if (Math.hypot(x - newer.centerX, y - newer.centerY) <= newer.rangeCells) {
            occluded = true;
            break;
          }
        }
        if (occluded) continue;
        best = { x, y, milli };
      }
    }
  }
  return best;
}

/** One-shot pulse queue for the in-world scan FX (drained by the fx layer). */
export function drainSurveyPulses(into: SurveyPulse[]): void {
  if (pulseQueue.length === 0) return;
  into.push(...pulseQueue);
  pulseQueue.length = 0;
}

// ── Dev ingest hook ──────────────────────────────────────────────────────
// Verification/demo seam matching the __successorFx pattern: lets the QA
// harness (and the FX-lab style workflows) paint synthetic survey discs
// without the trainer-grant tool + live spawn round-trip. DEV builds only.
declare global {
  interface Window {
    __successorSurveyIngest?: (areaId: string, msg: SurveyResultMessage) => boolean;
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__successorSurveyIngest = (areaId: string, msg: SurveyResultMessage) => ingestSurveyResult(areaId, msg);
}


// ── Active survey category & target family ───────────────────────────────
// Which category the SURVEY tool window currently operates on. Set when a
// category survey tool opens its window (inventory OPEN action). Within the
// category the player picks a TARGET family from the families the authority
// spawn snapshot actually has live (mineral: metal/copper today, carbon the
// moment it streams); the pick is remembered per category for the session —
// shard lifetime, resets with the page, same as the disc store.
let currentSurveyCategory: ResourceCategory = "mineral";
const selectedFamilyByCategory = new Map<ResourceCategory, string>();

export function setActiveSurveyCategory(category: ResourceCategory): void {
  currentSurveyCategory = category;
}

export function activeSurveyCategory(): ResourceCategory {
  return currentSurveyCategory;
}

/** Remember the player's target family pick for a category (canonicalized). */
export function setSelectedSurveyFamily(category: ResourceCategory, family: string): void {
  selectedFamilyByCategory.set(category, canonicalSurveyFamily(family));
}

/**
 * Effective survey target for a category, given the families currently on
 * offer (from the live spawn snapshot). The remembered pick wins while its
 * family is offered; a dormant pick falls back to the category's PRIMARY
 * family, then to the first offered family when even the primary sleeps.
 * An empty offer (no snapshot yet / nothing active) falls back to the
 * primary family so SURVEY stays honest about what it would scan.
 */
export function resolveSurveyFamily(
  category: ResourceCategory,
  offered: readonly string[],
): string {
  const remembered = selectedFamilyByCategory.get(category);
  if (remembered !== undefined && offered.includes(remembered)) return remembered;
  const primary = canonicalSurveyFamily(surveyFamilyForCategory(category));
  if (offered.length === 0 || offered.includes(primary)) return primary;
  return offered[0]!;
}

/** One selectable survey target — canonical wire family + human label. */
export interface SurveyFamilyOption {
  family: string;
  label: string;
}

/** Minimal spawn shape the options join needs (structural — accepts the
 *  authority's ServerAuthorityResourceSpawnState rows as-is). */
export interface SurveyFamilySpawnSource {
  family: string;
  classLabel: string;
}

/**
 * Live target options for a category from the authority resource-spawn
 * snapshot (full-replace list). One option per canonical family — a new
 * family (e.g. carbon) appears the moment the authority streams a spawn for
 * it and leaves when its last spawn expires. Labels ride the spawn's human
 * material label ("Iron"), falling back to the wire family key. Primary
 * family first, the rest alphabetical, so the row reads the same across
 * snapshot refreshes regardless of server list order.
 */
export function surveyFamilyOptionsFor(
  spawns: readonly SurveyFamilySpawnSource[],
  category: ResourceCategory,
): SurveyFamilyOption[] {
  const labelByFamily = new Map<string, string>();
  for (const spawn of spawns) {
    const family = canonicalSurveyFamily(spawn.family);
    if (resourceCategoryForFamily(family) !== category) continue;
    if (!labelByFamily.has(family)) {
      labelByFamily.set(family, spawn.classLabel.trim() || family);
    }
  }
  const primary = canonicalSurveyFamily(surveyFamilyForCategory(category));
  return [...labelByFamily.entries()]
    .map(([family, label]) => ({ family, label }))
    .sort((a, b) => {
      if (a.family === primary) return b.family === primary ? 0 : -1;
      if (b.family === primary) return 1;
      return a.label.localeCompare(b.label);
    });
}
