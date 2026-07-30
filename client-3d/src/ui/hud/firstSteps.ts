import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  isProfessionTrainerActor,
  professionTrainerInteractionRadiusCells,
} from "@successor/client/src/slice-core/professionTrainerSystem";
import { createWaypoint, deleteWaypoint } from "../waypoints/store";

/**
 * FIRST STEPS — one-shot diegetic guidance for a character's first session.
 * NOT a quest framework: no journal, no rewards, no server state. One small
 * top-center chip carries at most two rows:
 *
 *   - ONE objective ("find the trainer") whose breadcrumb is a real client
 *     waypoint seeded at the camp trainer — the existing beam / radar chevron /
 *     datapad marker ARE the guidance; the chip only names it.
 *   - At most THREE one-shot teachings (move / use / act), each shown once,
 *     contextually (use appears only when an interactable is actually in
 *     range; act only once a target is selected), and completed by the world
 *     action itself — never by reading.
 *
 * Persistence mirrors the waypoint store: a tiny per-character payload under
 * `successor3d.firststeps.<characterKey>`. Done steps never show again, so a
 * returning character sees nothing. Every row is click-to-dismiss.
 */

export type FirstStepId = "move" | "trainer" | "interact" | "act";

export const FIRST_STEPS_STORAGE_PREFIX = "successor3d.firststeps.";
const STORAGE_SCHEMA = "successor3d.firststeps.v1";
const ALL_STEPS: readonly FirstStepId[] = ["move", "trainer", "interact", "act"];

/** Distance from the boot cell that proves "the player can move". */
export const MOVE_DONE_CELLS = 2;
/** Objective slack beyond converse range so "reached" lands as the [F] chip appears. */
export const TRAINER_REACHED_CELLS = professionTrainerInteractionRadiusCells + 0.75;
/** A visible teaching auto-retires after this long — shown once, never nags. */
export const TEACH_LINGER_MS = 12_000;

export interface FirstStepsRecord {
  done: Set<FirstStepId>;
  /** Seeded breadcrumb waypoint id (deleted when the objective resolves). */
  waypointId: string | null;
}

export interface FirstStepsObservation {
  /** Distance from the authority-anchored baseline; 0 until authority hydrates. */
  movedCells: number;
  trainerReached: boolean;
  interactAvailable: boolean;
  /** Any interact window open (converse OR loot) — the F-verb landed. */
  interactWindowOpen: boolean;
  targetSelected: boolean;
  actQueued: boolean;
}

export interface FirstStepsGuidance {
  objectiveVisible: boolean;
  teach: "move" | "interact" | "act" | null;
}

// ── Pure core (testable without DOM) ───────────────────────────────────────

export function firstStepsStorageKey(characterKey: string): string {
  return `${FIRST_STEPS_STORAGE_PREFIX}${normalizeCharacterKey(characterKey)}`;
}

export function loadFirstSteps(storage: Storage | null, storageKey: string): FirstStepsRecord {
  const record: FirstStepsRecord = { done: new Set(), waypointId: null };
  if (!storage) return record;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return record;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return record;
    const payload = parsed as { done?: unknown; waypointId?: unknown };
    if (Array.isArray(payload.done)) {
      for (const id of payload.done) {
        if (typeof id === "string" && (ALL_STEPS as readonly string[]).includes(id)) {
          record.done.add(id as FirstStepId);
        }
      }
    }
    if (typeof payload.waypointId === "string" && payload.waypointId.length > 0) {
      record.waypointId = payload.waypointId;
    }
  } catch {
    // Unreadable payload = fresh record; guidance is client comfort, never truth.
  }
  return record;
}

export function saveFirstSteps(storage: Storage | null, storageKey: string, record: FirstStepsRecord): void {
  if (!storage) return;
  const payload = {
    schema: STORAGE_SCHEMA,
    done: ALL_STEPS.filter((id) => record.done.has(id)),
    waypointId: record.waypointId,
  };
  try {
    storage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Quota-blocked storage keeps the in-memory session state only.
  }
}

/**
 * World actions complete steps whenever they happen — even before their row
 * shows. The trainer objective resolves ONLY by physically reaching the
 * trainer: a converse window is not enough (talking to any social NPC — GR0K
 * included — must never mark the trainer found).
 */
export function completedSteps(record: FirstStepsRecord, obs: FirstStepsObservation): FirstStepId[] {
  const fresh: FirstStepId[] = [];
  if (!record.done.has("move") && obs.movedCells >= MOVE_DONE_CELLS) fresh.push("move");
  if (!record.done.has("trainer") && obs.trainerReached) fresh.push("trainer");
  if (!record.done.has("interact") && obs.interactWindowOpen) fresh.push("interact");
  if (!record.done.has("act") && obs.actQueued) fresh.push("act");
  return fresh;
}

/**
 * Progressive disclosure: MOVE alone first; then the objective row, with at
 * most one contextual teaching under it (USE preempts ACT — the nearer verb).
 */
export function firstStepsGuidance(record: FirstStepsRecord, obs: FirstStepsObservation): FirstStepsGuidance {
  if (!record.done.has("move")) return { objectiveVisible: false, teach: "move" };
  const teach = !record.done.has("interact") && obs.interactAvailable
    ? "interact" as const
    : !record.done.has("act") && obs.targetSelected
      ? "act" as const
      : null;
  return { objectiveVisible: !record.done.has("trainer"), teach };
}

export function firstStepsComplete(record: FirstStepsRecord): boolean {
  return ALL_STEPS.every((id) => record.done.has(id));
}

// ── Trainer lookup (any range — the breadcrumb target) ─────────────────────

export interface TrainerLocation {
  actorId: string;
  label: string;
  areaId: string;
  cellX: number;
  cellY: number;
  distanceCells: number;
}

export function nearestTrainerLocation(state: PlayState, slice: SliceSnapshot): TrainerLocation | null {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[meId] ?? null;
  const playerAreaId = me?.areaId ?? state.activeAreaId;
  const px = me?.x ?? state.player.x;
  const py = me?.y ?? state.player.y;
  let best: TrainerLocation | null = null;
  for (const source of slice.actors) {
    if (!isProfessionTrainerActor(source)) continue;
    const authority = state.serverAuthority.actors[source.id] ?? null;
    if (authority && authority.lifeState !== "alive") continue;
    const areaId = authority?.areaId ?? source.areaId;
    if (areaId !== playerAreaId) continue;
    const x = authority?.x ?? source.cell.x + 0.5;
    const y = authority?.y ?? source.cell.y + 0.5;
    const distanceCells = Math.hypot(px - x, py - y);
    if (best && distanceCells >= best.distanceCells) continue;
    best = {
      actorId: source.id,
      label: (authority?.displayName ?? authority?.label ?? source.label) || "Trainer",
      areaId,
      cellX: Math.floor(x),
      cellY: Math.floor(y),
      distanceCells,
    };
  }
  return best;
}

// ── HUD mount ──────────────────────────────────────────────────────────────

export interface FirstStepsController {
  dispose: () => void;
}

export interface FirstStepsDeps {
  /** Same per-character key the waypoint store is configured with. */
  characterKey: string;
  /** Converse window currently open (trainer talk — resolves the objective). */
  converseWindowOpen: () => boolean;
  /** Loot window currently open (cache/corpse — completes USE, never the objective). */
  lootWindowOpen: () => boolean;
  storage?: Storage | null;
}

interface FirstStepsProbe {
  version: number;
  done: FirstStepId[];
  objectiveVisible: boolean;
  teach: string | null;
  waypointId: string | null;
}

declare global {
  interface Window {
    __successor3dFirstSteps?: FirstStepsProbe;
  }
}

interface RowCopy {
  main: string;
  sub: string;
  hint: string;
}

const TEACH_COPY: Record<"move" | "interact" | "act", RowCopy> = {
  move: { main: "MOVE", sub: "WASD · click ground", hint: "Walk with WASD, or left-click the ground. Click to dismiss." },
  interact: { main: "USE", sub: "tap F", hint: "Tap F to talk, open, or take. Click to dismiss." },
  act: { main: "ACT", sub: "double-click a target", hint: "Double-click acts on your target. Click to dismiss." },
};

export function mountFirstSteps(
  shell: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
  deps: FirstStepsDeps,
): FirstStepsController {
  const storage = deps.storage === undefined
    ? (typeof window !== "undefined" ? window.localStorage : null)
    : deps.storage;
  const storageKey = firstStepsStorageKey(deps.characterKey);
  const record = loadFirstSteps(storage, storageKey);

  // Fully-guided characters mount nothing — zero DOM, zero per-frame work.
  if (firstStepsComplete(record)) {
    publishProbe(record, { objectiveVisible: false, teach: null });
    return { dispose: () => { delete window.__successor3dFirstSteps; } };
  }

  const root = document.createElement("div");
  root.className = "sc3d-first-steps";
  root.hidden = true;
  root.innerHTML = `
    <button type="button" class="sc3d-first-steps-row" data-ref="objective" hidden>
      <span class="sc3d-first-steps-mark" aria-hidden="true"></span>
      <span class="sc3d-first-steps-main">FIND THE TRAINER</span>
      <span class="sc3d-first-steps-sub">follow the light</span>
    </button>
    <button type="button" class="sc3d-first-steps-row" data-ref="teach" hidden>
      <span class="sc3d-first-steps-mark" aria-hidden="true"></span>
      <span class="sc3d-first-steps-main" data-ref="teachMain"></span>
      <span class="sc3d-first-steps-sub" data-ref="teachSub"></span>
    </button>`;
  shell.appendChild(root);
  const objectiveRow = ref(root, "objective");
  const teachRow = ref(root, "teach");
  const teachMain = ref(root, "teachMain");
  const teachSub = ref(root, "teachSub");

  // MOVE baseline anchors on the AUTHORITY player actor, taken only once it
  // exists: the client projection hydrating from its default to the authority
  // spawn must never count as movement.
  let baseline: { x: number; y: number } | null = null;
  let visibleTeach: "move" | "interact" | "act" | null = null;
  let teachShownAtMs = 0;
  let disposed = false;
  let frameId = 0;

  const persist = (): void => {
    saveFirstSteps(storage, storageKey, record);
  };

  const dropBreadcrumb = (): void => {
    if (record.waypointId === null) return;
    deleteWaypoint(record.waypointId);
    record.waypointId = null;
  };

  const seedBreadcrumb = (): void => {
    if (record.waypointId !== null || record.done.has("trainer")) return;
    const trainer = nearestTrainerLocation(state, slice);
    if (!trainer) return;
    const created = createWaypoint({
      name: trainer.label,
      x: trainer.cellX,
      y: trainer.cellY,
      areaId: trainer.areaId,
      active: true,
    });
    if (created.ok && created.waypoint) {
      record.waypointId = created.waypoint.id;
      objectiveRow.title = `${trainer.label} — at the light. Click to dismiss.`;
      persist();
    }
  };

  const complete = (id: FirstStepId): void => {
    if (record.done.has(id)) return;
    record.done.add(id);
    if (id === "trainer") dropBreadcrumb();
    persist();
  };

  objectiveRow.addEventListener("click", () => complete("trainer"));
  teachRow.addEventListener("click", () => {
    if (visibleTeach) complete(visibleTeach);
  });

  const observe = (): FirstStepsObservation => {
    const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const me = state.serverAuthority.actors[meId] ?? null;
    if (baseline === null && me !== null) baseline = { x: me.x, y: me.y };
    const trainer = nearestTrainerLocation(state, slice);
    const queueEntries = state.abilityQueue.view?.entries ?? [];
    return {
      movedCells: baseline !== null && me !== null ? Math.hypot(me.x - baseline.x, me.y - baseline.y) : 0,
      trainerReached: trainer !== null && trainer.distanceCells <= TRAINER_REACHED_CELLS,
      interactAvailable: state.interactions.options.length > 0,
      interactWindowOpen: deps.converseWindowOpen() || deps.lootWindowOpen(),
      targetSelected: state.selectedActorId !== null
        && state.selectedActorId !== (state.serverAuthority.playerActorId ?? state.playerActorId),
      actQueued: queueEntries.some((entry) => entry.class === "combat"),
    };
  };

  const frame = (): void => {
    if (disposed) return;
    const obs = observe();
    for (const id of completedSteps(record, obs)) complete(id);

    if (firstStepsComplete(record)) {
      dropBreadcrumb();
      persist();
      root.hidden = true;
      publishProbe(record, { objectiveVisible: false, teach: null });
      return; // guidance over — stop scheduling frames for good
    }

    const guidance = firstStepsGuidance(record, obs);
    if (guidance.objectiveVisible && record.waypointId === null) seedBreadcrumb();
    if (guidance.teach !== visibleTeach) {
      visibleTeach = guidance.teach;
      teachShownAtMs = performance.now();
      if (visibleTeach !== null) {
        const copy = TEACH_COPY[visibleTeach];
        teachMain.textContent = copy.main;
        teachSub.textContent = copy.sub;
        teachRow.title = copy.hint;
      }
    } else if (visibleTeach !== null && performance.now() - teachShownAtMs >= TEACH_LINGER_MS) {
      // Shown once, long enough to read — retire without the action.
      complete(visibleTeach);
      visibleTeach = null;
    }
    objectiveRow.hidden = !guidance.objectiveVisible;
    teachRow.hidden = visibleTeach === null;
    root.hidden = objectiveRow.hidden && teachRow.hidden;
    publishProbe(record, { objectiveVisible: guidance.objectiveVisible, teach: visibleTeach });
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose(): void {
      disposed = true;
      if (frameId) cancelAnimationFrame(frameId);
      root.remove();
      delete window.__successor3dFirstSteps;
    },
  };
}

function publishProbe(record: FirstStepsRecord, guidance: FirstStepsGuidance): void {
  if (typeof window === "undefined") return;
  const previous = window.__successor3dFirstSteps;
  window.__successor3dFirstSteps = {
    version: (previous?.version ?? 0) + 1,
    done: ALL_STEPS.filter((id) => record.done.has(id)),
    objectiveVisible: guidance.objectiveVisible,
    teach: guidance.teach,
    waypointId: record.waypointId,
  };
}

function ref(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!element) throw new Error(`first-steps ref missing: ${name}`);
  return element;
}

function normalizeCharacterKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64) || "observer";
}
