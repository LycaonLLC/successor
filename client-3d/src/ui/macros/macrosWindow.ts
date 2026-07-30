import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import {
  parseMacroBody,
  utf8ByteLength,
  type MacroProgram,
  type MacroRunSnapshot,
} from "@successor/client/src/slice-core/macroEngine/index";
import type { WindowContentHandle, WindowDefinition } from "../windows/windowManager";
import {
  localProviderNotice,
  macroLibraryRowByKey,
  macroLibraryRows,
  macroLibraryVersion,
  resolveMacroSource,
  type MacroLibraryRow,
} from "./library";
import { reasonCopy, type MacroRuntime } from "./runtime";
import {
  deleteMacro,
  macroById,
  macroCaps,
  macroStoreStatus,
  macros,
  saveMacro,
  type SavedMacro,
} from "./store";

/**
 * MACROS — the scripting bench (scripted-action panel, datapad grade).
 *
 * Three surfaces in one window:
 *   RUN DECK   — one socket per engine run slot: name, status lamp, source
 *                line (L<n> via a parse of the saved body), jump/loop count,
 *                STOP. Vacant sockets read DORMANT; STOP ALL sits in the head.
 *   DIRECTORY  — the merged three-provider library: the server-synced
 *                character record (successor.macros.v1, writable) over
 *                read-only LOCAL .macro files (desktop shell) over the
 *                immutable STARTER pack. Each row carries its source label;
 *                shadowed and broken rows stay visible (CLONE-only / error
 *                copy) instead of vanishing. RUN resolves by precedence.
 *   EDITOR     — designation + command body, live byte meter against the
 *                server cap, SAVE/DELETE with receipt-driven flashes.
 *
 * Deny wiring follows F1: every rejected action flashes the status foot and
 * plays ui_deny; accepted actions tick. Engine halts arrive through the
 * runtime notice sink (successor3dApp drains + sounds them even while this
 * window is closed; the sink hands the copy here for the flash).
 *
 * Keyboard: ESC inside the name/body fields blurs the field (stopPropagation,
 * waypoint-editor convention); the next ESC closes the window via the
 * manager. Chat-line parity lives in the slash router (/macro run|stop|list,
 * /dump) — this window is the visual twin of those verbs.
 */

import { MACROS_WINDOW_ID, type MacroNoticeSink } from "./macrosWindowIds";
export { MACROS_WINDOW_ID, type MacroNoticeSink };

export interface MacrosWindowDeps {
  runtime: MacroRuntime;
  notices: MacroNoticeSink;
  sfx?: SfxPlayer;
}


const STATUS_FLASH_MS = 2200;
const DISCARD_ARM_MS = 2600;
const NEW_BUFFER_TEMPLATE = "# command body — one verb per line, ; chains\n/where\n";

export function createMacrosWindowDefinition(deps: MacrosWindowDeps): WindowDefinition {
  return {
    id: MACROS_WINDOW_ID,
    title: "MACROS",
    icon: "macro",
    hotkey: "KeyM",
    minWidth: 540,
    minHeight: 420,
    defaultBounds: (viewport) => {
      const w = Math.max(540, Math.round(viewport.w * 0.44));
      const h = Math.max(420, Math.round(viewport.h * 0.6));
      return { x: Math.round(viewport.w * 0.08), y: Math.round(viewport.h * 0.16), w, h };
    },
    mount: (contentRoot) => mountMacrosContent(contentRoot, deps),
  };
}

interface SlotNodes {
  root: HTMLElement;
  name: HTMLElement;
  line: HTMLElement;
  state: HTMLElement;
  stop: HTMLButtonElement;
}

interface RowNodes {
  row: HTMLElement;
  badge: HTMLElement;
  run: HTMLButtonElement | null;
  name: string;
  runnable: boolean;
}

function mountMacrosContent(contentRoot: HTMLElement, deps: MacrosWindowDeps): WindowContentHandle {
  const { runtime } = deps;
  const root = document.createElement("div");
  root.className = "scp-root scp-macros";
  root.innerHTML = `
    <section class="scp-macro-deck">
      <header class="scp-macro-deck-head">
        <div class="scp-macros-title">
          <strong>RUN DECK</strong>
          <span data-ref="deckNote">0 / 4 SLOTS</span>
        </div>
        <button class="scp-macro-btn scp-macro-btn--danger" type="button" data-ref="stopAll">STOP ALL</button>
      </header>
      <div class="scp-macro-slots" data-ref="slots"></div>
    </section>
    <div class="scp-macro-split">
      <section class="scp-macro-library">
        <header class="scp-macro-lib-head">
          <div class="scp-macros-title">
            <strong>DIRECTORY</strong>
            <span data-ref="count">0 / 64</span>
          </div>
          <button class="scp-macro-btn scp-macro-btn--accent" type="button" data-ref="new">NEW MACRO</button>
        </header>
        <div class="scp-macro-list" data-ref="list"></div>
        <div class="scp-empty scp-macro-empty" data-ref="empty" hidden>
          <span>No macros on record</span>
          <small>NEW MACRO to author one</small>
        </div>
      </section>
      <section class="scp-macro-editor">
        <label class="scp-macro-field">
          <span>DESIGNATION</span>
          <input data-ref="name" type="text" maxlength="48" autocomplete="off" spellcheck="false"
            placeholder="heal self" aria-label="Macro name" />
        </label>
        <label class="scp-macro-field scp-macro-field--body">
          <span>COMMAND BODY</span>
          <textarea data-ref="body" spellcheck="false" wrap="off" aria-label="Macro body"
            placeholder="/target nearest hostile&#10;/attack $target&#10;/pause 1.5"></textarea>
        </label>
        <div class="scp-macro-meter">
          <span data-ref="bytes">0 / 8192 BYTES</span>
          <span data-ref="bufferTag">NEW BUFFER</span>
        </div>
        <div class="scp-macro-editor-actions">
          <button class="scp-macro-btn scp-macro-btn--accent" type="button" data-ref="save">SAVE</button>
          <button class="scp-macro-btn" type="button" data-ref="runBuffer">RUN</button>
          <button class="scp-macro-btn scp-macro-btn--danger" type="button" data-ref="delete">DELETE</button>
        </div>
      </section>
    </div>
    <footer class="scp-status-foot">
      <span class="scp-status-line" data-ref="status"></span>
      <span class="scp-macro-sync" data-ref="sync"></span>
    </footer>
  `;
  contentRoot.appendChild(root);

  const deckNoteEl = ref(root, "deckNote");
  const slotsEl = ref(root, "slots");
  const stopAllBtn = ref(root, "stopAll") as HTMLButtonElement;
  const countEl = ref(root, "count");
  const newBtn = ref(root, "new") as HTMLButtonElement;
  const listEl = ref(root, "list");
  const emptyEl = ref(root, "empty");
  const nameInput = ref(root, "name") as HTMLInputElement;
  const bodyInput = ref(root, "body") as HTMLTextAreaElement;
  const bytesEl = ref(root, "bytes");
  const bufferTagEl = ref(root, "bufferTag");
  const saveBtn = ref(root, "save") as HTMLButtonElement;
  const runBufferBtn = ref(root, "runBuffer") as HTMLButtonElement;
  const deleteBtn = ref(root, "delete") as HTMLButtonElement;
  const statusEl = ref(root, "status");
  const syncEl = ref(root, "sync");

  let disposed = false;
  let appliedLibraryVersion = -1;
  let editingId: string | null = null;
  /** Selected directory row (character:<id> | local:<file> | starter:<name>). */
  let selectedKey: string | null = null;
  let dirty = false;
  let statusFlashTimer = 0;
  let saving = false;
  // Two-step discard: first click on another row arms, second within the
  // window discards the dirty buffer (no silent data loss, no modal).
  let armedDiscardId: string | null = null;
  let armedDiscardAt = 0;

  const rowNodes = new Map<string, RowNodes>();
  const slotNodes: SlotNodes[] = [];
  // ip → source line needs the program; parses are cached per body string.
  const programCache = new Map<string, MacroProgram | null>();

  const flash = (message: string, ok: boolean): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusEl.toggleAttribute("data-bad", !ok);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };

  const receipt = (message: string, ok: boolean): void => {
    deps.sfx?.play(ok ? "ui_button_tick" : successorAudioIds.uiDeny);
    flash(message, ok);
  };

  // ── Editor buffer ────────────────────────────────────────────────────────
  const refreshMeter = (): void => {
    const bytes = utf8ByteLength(bodyInput.value);
    const cap = macroCaps().maxBodyBytes;
    bytesEl.textContent = `${bytes} / ${cap} BYTES`;
    const over = bytes > cap;
    bytesEl.toggleAttribute("data-over", over);
    saveBtn.disabled = saving || over;
  };

  const setBuffer = (macro: SavedMacro | null): void => {
    editingId = macro?.id ?? null;
    selectedKey = macro ? `character:${macro.id}` : null;
    nameInput.value = macro?.name ?? "";
    bodyInput.value = macro?.body ?? NEW_BUFFER_TEMPLATE;
    dirty = false;
    armedDiscardId = null;
    bufferTagEl.textContent = macro ? `EDITING · ${macro.id}` : "NEW BUFFER";
    deleteBtn.disabled = !macro;
    refreshMeter();
    renderList();
  };

  /** Starter/local rows are immutable: selecting one clones it into a new
   *  character buffer — SAVE writes the copy to the record (which then
   *  shadows the source name). The source row itself never changes. */
  const setCloneBuffer = (entry: MacroLibraryRow): void => {
    editingId = null;
    selectedKey = entry.key;
    nameInput.value = entry.name;
    bodyInput.value = entry.body ?? "";
    dirty = false;
    armedDiscardId = null;
    bufferTagEl.textContent = `CLONE · ${sourceLabel(entry.source)} — SAVE TO RECORD`;
    deleteBtn.disabled = true;
    refreshMeter();
    renderList();
  };

  const markDirty = (): void => {
    if (!dirty) {
      dirty = true;
      bufferTagEl.textContent = editingId ? `EDITING · ${editingId} · UNSAVED` : "NEW BUFFER · UNSAVED";
    }
    refreshMeter();
  };

  nameInput.addEventListener("input", markDirty);
  bodyInput.addEventListener("input", markDirty);
  // First ESC leaves the field; the manager's window ESC stays armed for the
  // next press (waypoint-editor convention).
  const blurOnEscape = (event: KeyboardEvent): void => {
    if (event.code !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).blur();
  };
  nameInput.addEventListener("keydown", blurOnEscape);
  bodyInput.addEventListener("keydown", blurOnEscape);

  const commitSave = (): void => {
    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    void saveMacro({ id: editingId, name: nameInput.value, body: bodyInput.value })
      .then((result) => {
        if (disposed) return;
        receipt(result.status, result.ok);
        if (result.ok && result.macro) {
          setBuffer(result.macro);
        }
      })
      .finally(() => {
        saving = false;
        if (!disposed) refreshMeter();
      });
  };

  const commitDelete = (): void => {
    if (!editingId || saving) return;
    saving = true;
    void deleteMacro(editingId)
      .then((result) => {
        if (disposed) return;
        receipt(result.status, result.ok);
        if (result.ok) setBuffer(null);
      })
      .finally(() => {
        saving = false;
        if (!disposed) refreshMeter();
      });
  };

  const runSaved = (name: string): void => {
    const result = runtime.start(name);
    if (result.ok) {
      const slots = runtime.runs().length;
      receipt(`RUNNING · ${name.toUpperCase()} — SLOT ${slots}/${runtime.engineState().caps.runSlots}`, true);
    } else {
      receipt(`DENIED · ${reasonCopy(result.reasonCode)}`, false);
    }
  };

  saveBtn.addEventListener("click", commitSave);
  deleteBtn.addEventListener("click", commitDelete);
  newBtn.addEventListener("click", () => {
    if (dirty && armedDiscardId !== "__new__") {
      armedDiscardId = "__new__";
      armedDiscardAt = performance.now();
      flash("UNSAVED BUFFER — NEW AGAIN TO DISCARD", false);
      return;
    }
    setBuffer(null);
    nameInput.focus();
  });
  runBufferBtn.addEventListener("click", () => {
    const saved = editingId ? macroById(editingId) : null;
    if (!saved || dirty) {
      receipt("DENIED · SAVE BEFORE RUN", false);
      return;
    }
    runSaved(saved.name);
  });
  stopAllBtn.addEventListener("click", () => {
    const stopped = runtime.stop("all");
    receipt(stopped > 0 ? `STOPPED · ${stopped} RUN${stopped === 1 ? "" : "S"}` : "DENIED · NOTHING RUNNING", stopped > 0);
  });

  // ── Directory list ───────────────────────────────────────────────────────
  listEl.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>(".scp-macro-row");
    const key = row?.dataset.key;
    if (!key) return;
    const entry = macroLibraryRowByKey(key);
    if (!entry) {
      receipt("DENIED · MACRO GONE", false);
      return;
    }
    const actionBtn = target.closest<HTMLButtonElement>("button[data-action]");
    if (actionBtn) {
      event.preventDefault();
      if (actionBtn.dataset.action === "run") runSaved(entry.name);
      else if (actionBtn.dataset.action === "stop") {
        const stopped = runtime.stop(entry.name);
        receipt(stopped > 0 ? `STOPPED · ${entry.name.toUpperCase()}` : "DENIED · NOT RUNNING", stopped > 0);
      }
      return;
    }
    if (key === selectedKey) return;
    if (dirty && armedDiscardId !== key) {
      armedDiscardId = key;
      armedDiscardAt = performance.now();
      flash("UNSAVED BUFFER — CLICK AGAIN TO DISCARD", false);
      return;
    }
    if (entry.source === "character" && entry.savedId) {
      setBuffer(macroById(entry.savedId));
    } else if (entry.body !== null) {
      setCloneBuffer(entry);
    } else {
      receipt(`DENIED · ${(entry.error ?? "UNREADABLE").toUpperCase()}`, false);
    }
  });

  const SOURCE_LABEL: Record<MacroLibraryRow["source"], string> = {
    character: "RECORD",
    local: "LOCAL",
    starter: "STARTER",
  };
  function sourceLabel(source: MacroLibraryRow["source"]): string {
    return SOURCE_LABEL[source];
  }

  function renderList(): void {
    appliedLibraryVersion = macroLibraryVersion();
    rowNodes.clear();
    listEl.textContent = "";
    const entries = macroLibraryRows();
    countEl.textContent = `${macros().length} / ${macroCaps().maxItems}`;
    emptyEl.hidden = entries.length > 0;
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "scp-macro-row";
      row.dataset.key = entry.key;
      row.dataset.source = entry.source;
      row.toggleAttribute("data-selected", entry.key === selectedKey);
      row.toggleAttribute("data-error", entry.error !== null);
      row.toggleAttribute("data-shadowed", entry.shadowed);

      const marker = document.createElement("span");
      marker.className = "scp-macro-marker";
      marker.setAttribute("aria-hidden", "true");

      const main = document.createElement("div");
      main.className = "scp-macro-main";
      const name = document.createElement("strong");
      name.className = "scp-macro-name";
      name.textContent = entry.name;
      const preview = document.createElement("span");
      preview.className = "scp-macro-preview";
      preview.textContent = entry.error ? entry.error.toUpperCase() : entry.preview;
      preview.toggleAttribute("data-bad", entry.error !== null);
      main.append(name, preview);

      const source = document.createElement("span");
      source.className = "scp-macro-source";
      source.dataset.source = entry.source;
      source.textContent = entry.shadowed ? "SHADOWED" : sourceLabel(entry.source);

      const badge = document.createElement("span");
      badge.className = "scp-macro-badge";

      const weight = document.createElement("span");
      weight.className = "scp-macro-weight";
      weight.textContent = entry.body !== null ? `${utf8ByteLength(entry.body)}B` : "—";

      const actions = document.createElement("div");
      actions.className = "scp-macro-row-actions";
      // Direct run for any healthy, unshadowed row — starter and local
      // macros run as-is; shadowed rows defer to the winning name.
      const runnable = entry.error === null && !entry.shadowed;
      let run: HTMLButtonElement | null = null;
      if (runnable) {
        run = document.createElement("button");
        run.type = "button";
        run.className = "scp-macro-btn";
        run.dataset.action = "run";
        run.textContent = "RUN";
        actions.appendChild(run);
      }

      row.append(marker, main, source, badge, weight, actions);
      listEl.appendChild(row);
      rowNodes.set(entry.key, { row, badge, run, name: entry.name, runnable });
    }
    refreshRunBadges();
    refreshSyncLine();
  }

  /** RUNNING badges + row RUN→STOP swap, diffed off live engine state. */
  function refreshRunBadges(): void {
    const running = new Set<string>();
    for (const run of runtime.runs()) running.add(run.name.toLowerCase());
    for (const [key, nodes] of rowNodes) {
      const active = nodes.runnable && running.has(nodes.name.toLowerCase());
      if (nodes.row.hasAttribute("data-running") !== active) {
        nodes.row.toggleAttribute("data-running", active);
        nodes.badge.textContent = active ? "RUNNING" : "";
        if (nodes.run) {
          nodes.run.dataset.action = active ? "stop" : "run";
          nodes.run.textContent = active ? "STOP" : "RUN";
          nodes.run.classList.toggle("scp-macro-btn--danger", active);
        }
      }
      nodes.row.toggleAttribute("data-selected", key === selectedKey);
    }
  }

  // ── Run deck ─────────────────────────────────────────────────────────────
  const buildDeck = (slotCount: number): void => {
    slotNodes.length = 0;
    slotsEl.textContent = "";
    for (let index = 0; index < slotCount; index += 1) {
      const socket = document.createElement("div");
      socket.className = "scp-macro-slot";
      socket.innerHTML = `
        <span class="scp-macro-slot-lamp" aria-hidden="true"></span>
        <div class="scp-macro-slot-main">
          <strong data-ref="slotName">SLOT ${index + 1}</strong>
          <span data-ref="slotLine">DORMANT</span>
        </div>
        <span class="scp-macro-slot-state" data-ref="slotState"></span>
        <button class="scp-macro-btn scp-macro-btn--danger" type="button" data-ref="slotStop" hidden>STOP</button>
      `;
      slotsEl.appendChild(socket);
      slotNodes.push({
        root: socket,
        name: inner(socket, "slotName"),
        line: inner(socket, "slotLine"),
        state: inner(socket, "slotState"),
        stop: inner(socket, "slotStop") as HTMLButtonElement,
      });
    }
  };

  slotsEl.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-run-id]");
    if (!button) return;
    const stopped = runtime.stop(button.dataset.runId ?? "");
    receipt(stopped > 0 ? "STOPPED · RUN SLOT" : "DENIED · RUN GONE", stopped > 0);
  });

  const sourceLineFor = (run: MacroRunSnapshot): string => {
    if (run.stackDepth > 1) return `CHAIN ×${run.stackDepth}`;
    const hit = resolveMacroSource(run.name);
    if (!hit) return `IP ${run.instructionPointer}`;
    let program = programCache.get(hit.body);
    if (program === undefined) {
      try {
        program = parseMacroBody(hit.body, { caps: { bodyBytes: macroCaps().maxBodyBytes } });
      } catch {
        program = null;
      }
      if (programCache.size > 16) programCache.clear();
      programCache.set(hit.body, program);
    }
    if (!program) return `IP ${run.instructionPointer}`;
    const statement = program.statements[Math.min(run.instructionPointer, program.statements.length - 1)];
    return statement ? `L${statement.line} · ${statement.source.slice(0, 24)}` : "END";
  };

  const STATUS_LABEL: Record<MacroRunSnapshot["status"], string> = {
    running: "RUNNING",
    paused: "PAUSE",
    waiting_receipt: "AWAIT RECEIPT",
    waiting_until: "AWAIT UNTIL",
    yielded: "YIELDED",
    completed: "DONE",
    stopped: "STOPPED",
    halted: "HALTED",
  };

  function refreshDeck(): void {
    const engineState = runtime.engineState();
    const runs = engineState.activeRuns;
    const slotCount = engineState.caps.runSlots;
    if (slotNodes.length !== slotCount) buildDeck(slotCount);
    deckNoteEl.textContent = `${runs.length} / ${slotCount} SLOTS`;
    stopAllBtn.disabled = runs.length === 0;
    for (let index = 0; index < slotNodes.length; index += 1) {
      const nodes = slotNodes[index]!;
      const run = runs[index] ?? null;
      const status = run ? run.status : null;
      nodes.root.dataset.status = status ?? "vacant";
      nodes.root.toggleAttribute("data-vacant", !run);
      if (!run) {
        nodes.name.textContent = `SLOT ${index + 1}`;
        nodes.line.textContent = "DORMANT";
        nodes.state.textContent = "";
        nodes.stop.hidden = true;
        delete nodes.stop.dataset.runId;
        continue;
      }
      nodes.name.textContent = run.name.toUpperCase();
      nodes.line.textContent = `${sourceLineFor(run)} · J${run.jumpsUsed}`;
      nodes.state.textContent = STATUS_LABEL[run.status];
      nodes.stop.hidden = false;
      nodes.stop.dataset.runId = run.runId;
    }
  }

  const refreshSyncLine = (): void => {
    const status = macroStoreStatus();
    let text: string;
    let bad = false;
    switch (status.phase) {
      case "synced":
      case "seeded":
        text = `RECORD SYNCED · ${macros().length}/${macroCaps().maxItems}`;
        break;
      case "syncing":
        text = "SYNCING…";
        break;
      case "link_down":
        text = "LINK DOWN — RECORD OFFLINE";
        bad = true;
        break;
      case "denied":
        text = status.detail ?? "RECORD DENIED";
        bad = true;
        break;
      default:
        text = "NO CHARACTER RECORD";
        bad = true;
    }
    // Local .macro provider trouble rides the same foot: dir failures and
    // per-file load/parse errors must be visible without opening a row.
    const notice = localProviderNotice();
    if (notice) {
      text = `${text} · ${notice}`;
      bad = true;
    }
    syncEl.textContent = text;
    syncEl.toggleAttribute("data-bad", bad);
  };

  // ── Boot ─────────────────────────────────────────────────────────────────
  buildDeck(runtime.engineState().caps.runSlots);
  setBuffer(macros()[0] ?? null);
  // C6: no boot flash — the window opening IS the feedback.

  return {
    update(): void {
      if (appliedLibraryVersion !== macroLibraryVersion()) {
        renderList();
        // The edited macro may have been replaced/deleted by a sync.
        if (editingId && !macroById(editingId) && !dirty) setBuffer(macros()[0] ?? null);
      }
      if (armedDiscardId && performance.now() - armedDiscardAt > DISCARD_ARM_MS) armedDiscardId = null;
      refreshDeck();
      refreshRunBadges();
      const notice = deps.notices.take();
      if (notice) flash(notice.text, !notice.bad);
    },
    onResized(): void {},
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(statusFlashTimer);
      root.remove();
    },
  };
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`macros window: missing data-ref="${name}"`);
  return el;
}

function inner(scope: HTMLElement, name: string): HTMLElement {
  const el = scope.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`macros window: missing slot data-ref="${name}"`);
  return el;
}
