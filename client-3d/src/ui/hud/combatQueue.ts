import { authorityIssuedAtServerTick } from "@successor/client/src/slice-core/authorityCommandSystem";
import { installDraggablePanel } from "@successor/client/src/slice-core/draggablePanelSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { cleanActorName } from "./actorNames";
import { combatReasonCopy as reasonCopy } from "./combatLog";

/**
 * ACTION QUEUE — the vertically stacked combat queue (owner directive
 * 2026-07-08: relocation + redesign; supersedes the top-right "combat
 * queue" placement and the retired bottom-center strip's sweep).
 *
 * DEFAULT DOCK: left of the radar plate (top-right band), taller, scrollable
 * when deep. The pane is draggable by its head via the HOUSE drag system
 * (slice-core installDraggablePanel — [data-panel-drag-handle] plus
 * persisted position; storage key
 * `successor.action-queue-panel.position.v2`). Users move it; we only own
 * the DEFAULT.
 *
 * ROW ANATOMY: [state lamp | ACTION NAME | target | state stamp] over a
 * cast/cooldown progress rail. The CURRENT action (first live row —
 * repeat intent first, matching drain order) reads emphasized: accent
 * rail, brighter ink, live progress toward `nextReadyTick` on the same
 * estimated-server-tick math the old strip sweep used.
 *
 * Motion language retained from the E2 pane: entries SLIDE IN, FIRED
 * flashes green on the execution beat then collapses, rejects fade with
 * their reasonCode stamped, repeat intents pulse per fireSeq and stay
 * armed. Player abilities ONLY (spec §F session scope).
 */

export interface AbilityQueueEntryVM {
  id: string;
  abilityId: string;
  iconId: string;
  class: "combat" | "posture" | "utility";
  targetActorId?: string;
  lifecycle: "enqueued" | "pending" | "fired" | "dismissed";
  enqueuedAtTick: number;
  readyTick?: number;
  firedAtTick?: number;
  dismissedAtTick?: number;
  reasonCode?: string;
  fireSeq?: number;
}

export interface AbilityQueueView {
  actorId: string;
  nextReadyTick: number;
  entries: AbilityQueueEntryVM[];
  repeatIntent?: AbilityQueueEntryVM;
}

export interface AbilityQueueEvent {
  id: string;
  lifecycle: "enqueued" | "pending" | "fired" | "dismissed";
  tick: number;
  reasonCode?: string;
  fireSeq?: number;
  /** Present on fired/dismissed so rowless events can materialize a beat. */
  abilityId?: string;
  iconId?: string;
}

export interface QueueSource {
  /** Latest session-scoped queue view for the LOCAL player, or null. */
  view: () => AbilityQueueView | null;
  /**
   * Authoritative lifecycle events since the last drain. FIRED/DISMISSED are
   * one-tick transients (spec §F) — a polled view can miss them at network
   * cadence, so the green-fire/fade beats key off THESE, never the snapshot.
   */
  drainEvents: () => AbilityQueueEvent[];
  /** Owner-initiated clear (wired to CancelAbilityQueue when C3 lands). */
  clear: () => void;
}

export interface CombatQueueController {
  dispose: () => void;
}

const FIRE_FLASH_MS = 280;
const EXIT_MS = 320;

/** Ability icon set — 12px stroke-first marks in the HUD line weight. */
const ICONS: Record<string, string> = {
  basic_shot: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="2.2" fill="none" stroke="currentColor"/><path d="M6 .8v2.4M6 8.8v2.4M.8 6h2.4M8.8 6h2.4" stroke="currentColor" stroke-linecap="round"/></svg>',
  aimed_shot: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor"/><circle cx="6" cy="6" r="1.1" fill="currentColor"/><path d="M6 0v2.2M6 9.8V12M0 6h2.2M9.8 6H12" stroke="currentColor"/></svg>',
  melee_strike: '<svg viewBox="0 0 12 12"><path d="M1.5 10.5 8.8 3.2M8 1.6l2.4 2.4M7 4.9l.9.9" fill="none" stroke="currentColor" stroke-linecap="round"/><path d="M1.5 10.5l1.8-.5-1.3-1.3z" fill="currentColor"/></svg>',
  peace: '<svg viewBox="0 0 12 12"><path d="M3 6.8V3.4a.9.9 0 0 1 1.8 0m0 2.6V2.4a.9.9 0 0 1 1.8 0m0 3V3.4a.9.9 0 0 1 1.8 0v4.2A3.4 3.4 0 0 1 5 11h-.2C3 11 2.4 9.6 2 8.4L1.4 6.6a.8.8 0 0 1 1.4-.6z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>',
  kneel: '<svg viewBox="0 0 12 12"><circle cx="6.2" cy="2.2" r="1.4" fill="currentColor"/><path d="M6 4v3l-2.4 2.2M6 7l2.8 1 .4 2.6" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>',
  stim: '<svg viewBox="0 0 12 12"><path d="M2 10 10 2M4.4 4.4l3.2 3.2M3 7.6 4.4 9M8.4 1.2l2.4 2.4" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>',
  default: '<svg viewBox="0 0 12 12"><path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="none" stroke="currentColor"/></svg>',
};

const ABILITY_LABEL: Record<string, string> = {
  basic_shot: "SHOT",
  aimed_shot: "AIMED SHOT",
  melee_strike: "STRIKE",
  peace: "PEACE",
  kneel: "KNEEL",
  stim: "STIM",
};

function iconSvg(iconId: string): string {
  return ICONS[iconId] ?? ICONS.default!;
}

function abilityLabel(abilityId: string): string {
  return ABILITY_LABEL[abilityId] ?? abilityId.replace(/[-_]/g, " ").toUpperCase();
}

interface RowState {
  el: HTMLElement;
  lifecycle: AbilityQueueEntryVM["lifecycle"];
  fireSeq: number;
  exiting: boolean;
  /** Repeat-intent rows pulse on fire and stay armed (never auto-exit). */
  repeat: boolean;
}

const RADAR_BOX_PX = 170; // radar plate: 156 scope + 2×6 padding + 2×1 border
const PANE_WIDTH_PX = 232;
const PANE_RIGHT_GUTTER_PX = 10;

export function mountCombatQueue(
  shell: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
  source: QueueSource,
): CombatQueueController {
  const pane = document.createElement("aside");
  pane.className = "sc3d-cqueue";
  pane.setAttribute("aria-label", "Action queue");
  pane.innerHTML = `
    <div class="sc3d-cqueue-head" data-panel-drag-handle title="Drag to move">
      <span class="sc3d-cqueue-title">ACTION QUEUE</span>
      <button type="button" class="sc3d-cqueue-clear" data-ref="clear" title="Clear combat queue">CLEAR</button>
    </div>
    <div class="sc3d-cqueue-scroll" data-ref="scroll"></div>
  `;
  shell.appendChild(pane);
  const scrollEl = pane.querySelector<HTMLElement>('[data-ref="scroll"]')!;
  const clearBtn = pane.querySelector<HTMLButtonElement>('[data-ref="clear"]')!;
  clearBtn.addEventListener("click", () => source.clear());
  // House drag: position persists; size stays content-driven (no persist).
  const disposeDrag = installDraggablePanel({
    panel: pane,
    storage: window.localStorage,
    storageKey: "successor.action-queue-panel.position.v2",
    minWidth: PANE_WIDTH_PX,
    minHeight: 40,
    shouldPersistSize: () => false,
    defaultPosition: (viewport) => ({
      left: Math.max(8, viewport.innerWidth - 14 - RADAR_BOX_PX - PANE_RIGHT_GUTTER_PX - PANE_WIDTH_PX),
      top: 14,
    }),
  });

  const rows = new Map<string, RowState>();

  const buildRow = (entry: AbilityQueueEntryVM): HTMLElement => {
    const row = document.createElement("div");
    row.className = "sc3d-cqueue-rowwrap";
    row.dataset.entryId = entry.id;
    const target = entry.targetActorId
      ? targetLabelFor(state, entry.targetActorId)
      : null;
    // Static skeleton only — icon markup comes from the trusted ICONS table.
    // Name/target are entry/server-derived text (player names!) and MUST land
    // via textContent, never interpolated into HTML.
    row.innerHTML = `
      <div class="sc3d-cqueue-row">
        <span class="sc3d-cqueue-lamp" aria-hidden="true"></span>
        <span class="sc3d-cqueue-icon">${iconSvg(entry.iconId)}</span>
        <div class="sc3d-cqueue-main">
          <span class="sc3d-cqueue-name" data-ref="name"></span>
          ${target !== null ? '<span class="sc3d-cqueue-target" data-ref="target"></span>' : ""}
        </div>
        ${entry.fireSeq !== undefined ? '<span class="sc3d-cqueue-seq" data-ref="seq"></span>' : ""}
        <span class="sc3d-cqueue-state" data-ref="state"></span>
        <span class="sc3d-cqueue-rail" aria-hidden="true"><span class="sc3d-cqueue-railfill" data-ref="rail"></span></span>
      </div>
    `;
    const inner = row.querySelector<HTMLElement>(".sc3d-cqueue-row")!;
    inner.dataset.class = entry.class;
    inner.dataset.lifecycle = entry.lifecycle;
    inner.querySelector<HTMLElement>('[data-ref="name"]')!.textContent = abilityLabel(entry.abilityId);
    if (target !== null) {
      inner.querySelector<HTMLElement>('[data-ref="target"]')!.textContent = target;
    }
    return row;
  };

  const setStateStamp = (row: HTMLElement, text: string, kind: "" | "fired" | "reject"): void => {
    const stamp = row.querySelector<HTMLElement>('[data-ref="state"]');
    if (!stamp) return;
    if (stamp.textContent !== text) stamp.textContent = text;
    stamp.dataset.kind = kind;
  };

  const beginExit = (id: string, row: RowState, reasonCode?: string): void => {
    if (row.exiting) return;
    row.exiting = true;
    if (reasonCode) setStateStamp(row.el, reasonCopy(reasonCode), "reject");
    row.el.classList.add("sc3d-cqueue-exit");
    window.setTimeout(() => {
      row.el.remove();
      if (rows.get(id) === row) rows.delete(id);
    }, EXIT_MS);
  };

  // Current-action emphasis + rail sweep state (anchored on nextReadyTick moves).
  let markedCurrentId: string | null = null;
  let sweepStartTick = 0;
  let sweepEndTick = 0;
  let appliedFill = -1;

  const sync = (): void => {
    // 1) EVENTS first — the authoritative beats (fired flash, dismissal exits).
    for (const event of source.drainEvents()) {
      let row = rows.get(event.id);
      if (!row && event.lifecycle === "fired" && event.abilityId) {
        // one-shot that enqueued+fired between snapshots: synthesize the row
        // so the green beat still lands, then let it exit normally
        const el = buildRow({
          id: event.id,
          abilityId: event.abilityId,
          iconId: event.iconId ?? "default",
          class: "combat",
          lifecycle: "fired",
          enqueuedAtTick: event.tick,
        });
        scrollEl.appendChild(el);
        requestAnimationFrame(() => el.classList.add("sc3d-cqueue-in"));
        row = { el, lifecycle: "fired", fireSeq: event.fireSeq ?? 0, exiting: false, repeat: false };
        rows.set(event.id, row);
      }
      if (!row) continue; // enqueue/pending events materialize via the view below
      if (event.lifecycle === "fired") {
        row.fireSeq = event.fireSeq ?? row.fireSeq;
        flashFired(row.el);
        if (!row.repeat) {
          window.setTimeout(() => {
            const live = rows.get(event.id);
            if (live) beginExit(event.id, live);
          }, FIRE_FLASH_MS);
        }
        row.lifecycle = "fired";
      } else if (event.lifecycle === "dismissed") {
        beginExit(event.id, row, event.reasonCode);
      }
    }
    // 2) VIEW — structure reconciliation (adds, pending stamps, repeat seq).
    const view = source.view();
    const live = new Set<string>();
    const ordered: AbilityQueueEntryVM[] = [];
    if (view?.repeatIntent) ordered.push(view.repeatIntent);
    if (view) ordered.push(...view.entries);
    for (const entry of ordered) {
      if (entry.lifecycle === "dismissed") {
        const row = rows.get(entry.id);
        if (row) beginExit(entry.id, row, entry.reasonCode);
        continue;
      }
      live.add(entry.id);
      let row = rows.get(entry.id);
      if (!row) {
        const el = buildRow(entry);
        scrollEl.appendChild(el);
        // enter: next frame so the transition runs
        requestAnimationFrame(() => el.classList.add("sc3d-cqueue-in"));
        row = { el, lifecycle: entry.lifecycle, fireSeq: entry.fireSeq ?? 0, exiting: false, repeat: view?.repeatIntent?.id === entry.id };
        rows.set(entry.id, row);
      }
      // FIRED: green flash on the exact transition (or fireSeq bump for repeats)
      const seqBumped = entry.fireSeq !== undefined && entry.fireSeq > row.fireSeq;
      if ((entry.lifecycle === "fired" && row.lifecycle !== "fired") || seqBumped) {
        // belt-and-braces: a view snapshot that catches the transient still
        // renders the beat even if the event stream hiccuped
        row.fireSeq = entry.fireSeq ?? row.fireSeq;
        flashFired(row.el);
        if (!row.repeat) {
          window.setTimeout(() => beginExit(entry.id, rows.get(entry.id) ?? row), FIRE_FLASH_MS);
        }
      }
      if (entry.fireSeq !== undefined) {
        const seq = row.el.querySelector<HTMLElement>('[data-ref="seq"]');
        if (seq && seq.textContent !== `×${entry.fireSeq}`) seq.textContent = entry.fireSeq > 0 ? `×${entry.fireSeq}` : "";
      }
      if (entry.lifecycle === "pending" && row.lifecycle !== "pending") setStateStamp(row.el, "QUEUED", "");
      row.lifecycle = entry.lifecycle;
      const inner = row.el.querySelector<HTMLElement>(".sc3d-cqueue-row");
      if (inner && inner.dataset.lifecycle !== entry.lifecycle) inner.dataset.lifecycle = entry.lifecycle;
    }
    // entries gone from the view without a dismissed record: exit gracefully
    for (const [id, row] of rows) {
      if (!live.has(id) && !row.exiting) beginExit(id, row);
    }
    // CURRENT action: first live row in drain order — emphasized, and its
    // rail sweeps toward nextReadyTick (the old strip sweep, now per-row).
    const currentId = ordered.find((entry) => entry.lifecycle !== "dismissed" && !rows.get(entry.id)?.exiting)?.id ?? null;
    if (currentId !== markedCurrentId) {
      if (markedCurrentId) rows.get(markedCurrentId)?.el.querySelector(".sc3d-cqueue-row")?.removeAttribute("data-current");
      markedCurrentId = currentId;
      if (currentId) rows.get(currentId)?.el.querySelector(".sc3d-cqueue-row")?.setAttribute("data-current", "");
    }
    if (currentId) {
      const estTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      const nextReady = view?.nextReadyTick ?? 0;
      if (nextReady !== sweepEndTick) {
        sweepStartTick = estTick;
        sweepEndTick = nextReady;
      }
      let fill = 1;
      if (sweepEndTick > sweepStartTick) {
        fill = Math.max(0, Math.min(1, (estTick - sweepStartTick) / (sweepEndTick - sweepStartTick)));
      }
      const rounded = Math.round(fill * 100) / 100;
      if (rounded !== appliedFill) {
        appliedFill = rounded;
        const rail = rows.get(currentId)?.el.querySelector<HTMLElement>('[data-ref="rail"]');
        if (rail) rail.style.transform = `scaleX(${rounded})`;
      }
    }
    pane.dataset.empty = rows.size === 0 ? "1" : "0";
  };

  let frameId = 0;
  const frame = (): void => {
    frameId = requestAnimationFrame(frame);
    sync();
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(frameId);
      disposeDrag();
      pane.remove();
    },
  };
}

function flashFired(rowWrap: HTMLElement): void {
  const row = rowWrap.querySelector<HTMLElement>(".sc3d-cqueue-row");
  if (!row) return;
  row.classList.remove("sc3d-cqueue-fired");
  // restart the animation even on rapid repeats
  void row.offsetWidth;
  row.classList.add("sc3d-cqueue-fired");
  const stamp = row.querySelector<HTMLElement>('[data-ref="state"]');
  if (stamp) {
    stamp.textContent = "FIRED";
    stamp.dataset.kind = "fired";
  }
}

function targetLabelFor(state: PlayState, actorId: string): string {
  // Clean-name chain (C1): display_name-grade names; the composite label's
  // type read never eats the row budget. CSS ellipsizes past the hard cap.
  return cleanActorName(state.serverAuthority.actors[actorId], actorId).toUpperCase().slice(0, 24);
}

// ── dev seam: scripted mock driver (removed when C3 wires the live channel) ──

export interface CombatQueueDemoHandle {
  running: boolean;
}

/**
 * FX-LAB-style preview: drives the pane through the full motion vocabulary —
 * enqueue three abilities, fire them in cadence, arm a repeat intent that
 * pulses twice, reject one entry, then clear. window.__combatQueueDemo().
 */
export function makeDemoSource(): { source: QueueSource; start: () => void; running: () => boolean } {
  let view: AbilityQueueView | null = null;
  let timer = 0;
  const pendingEvents: AbilityQueueEvent[] = [];
  const emit = (id: string, lifecycle: AbilityQueueEvent["lifecycle"], extra?: Partial<AbilityQueueEvent>): void => {
    pendingEvents.push({ id, lifecycle, tick: 0, ...extra });
  };
  const clearAll = (): void => {
    if (view) {
      for (const entry of view.entries) {
        if (entry.lifecycle !== "dismissed") emit(entry.id, "dismissed");
        entry.lifecycle = "dismissed";
        entry.reasonCode = undefined;
      }
      if (view.repeatIntent && view.repeatIntent.lifecycle !== "dismissed") {
        emit(view.repeatIntent.id, "dismissed");
        view.repeatIntent.lifecycle = "dismissed";
      }
    }
  };
  const start = (): void => {
    if (timer) window.clearTimeout(timer);
    const mk = (id: string, abilityId: string, iconId: string, cls: AbilityQueueEntryVM["class"], fireSeq?: number): AbilityQueueEntryVM => ({
      id, abilityId, iconId, class: cls, lifecycle: "enqueued", enqueuedAtTick: 0, ...(fireSeq !== undefined ? { fireSeq } : {}),
    });
    view = {
      actorId: "local",
      nextReadyTick: 0,
      entries: [],
      repeatIntent: undefined,
    };
    const steps: Array<[number, () => void]> = [
      [200, () => { view!.entries.push(mk("d1", "aimed_shot", "aimed_shot", "combat")); }],
      [650, () => { view!.entries.push(mk("d2", "melee_strike", "melee_strike", "combat")); }],
      [1100, () => { view!.entries.push(mk("d3", "stim", "stim", "utility")); }],
      [1500, () => { view!.entries[0]!.lifecycle = "fired"; emit("d1", "fired"); }],
      [2300, () => { view!.entries[1]!.lifecycle = "fired"; emit("d2", "fired"); }],
      [2900, () => { view!.entries[2]!.lifecycle = "dismissed"; view!.entries[2]!.reasonCode = "actor_not_alive"; emit("d3", "dismissed", { reasonCode: "actor_not_alive" }); }],
      [3400, () => { view!.repeatIntent = mk("dr", "basic_shot", "basic_shot", "combat", 0); view!.repeatIntent.lifecycle = "pending"; }],
      [4000, () => { view!.repeatIntent!.lifecycle = "fired"; view!.repeatIntent!.fireSeq = 1; emit("dr", "fired", { fireSeq: 1 }); }],
      [4650, () => { view!.repeatIntent!.fireSeq = 2; emit("dr", "fired", { fireSeq: 2 }); }],
      [5600, () => { clearAll(); }],
      [6300, () => { view = null; timer = 0; }],
    ];
    let at = 0;
    const runStep = (i: number): void => {
      if (i >= steps.length) return;
      const [ms, fn] = steps[i]!;
      timer = window.setTimeout(() => { fn(); runStep(i + 1); }, ms - at);
      at = ms;
    };
    runStep(0);
  };
  return {
    source: {
      view: () => view,
      drainEvents: () => pendingEvents.splice(0, pendingEvents.length),
      clear: clearAll,
    },
    start,
    running: () => timer !== 0,
  };
}
