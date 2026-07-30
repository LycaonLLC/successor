import "./dialogue.css";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityPurchaseSkillBoxCommand,
  enqueueAuthoritySetCareerGoalCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { isTextInputTarget } from "@successor/client/src/slice-core/inputController";
import { skillNodeDefinitions } from "@successor/client/src/slice-core/progressionSystem";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import { isLocalInventoryContainer } from "../inventory/data";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windows/windowManager";
import {
  playerActor,
  holdsAllOwnedOrExchangeItems,
  resolveNode,
  skillBoxTrained,
  trainerDialogueNpc,
  STARTER_TOOL_ITEM_IDS,
  type DialogueAction,
  type DialogueCtx,
  type DialogueNpc,
  type DialogueTree,
  type ResolvedNode,
} from "./dialogueTree";
import { mountNpcPortrait, type NpcPortraitHandle } from "./npcPortrait";
import { enqueueStarterToolRequest } from "./starterToolLeaf";
import { trainerDialogueTree } from "./trainerScripts";

/**
 * CONVERSE — the established sandbox-style dialogue window (owner ask: talk to trainers,
 * don't get plopped onto the skills menu).
 *
 * Journey (DESIGN.md lens): right-click a trainer → CONVERSE (default) → this
 * window: NPC bust + prose on the left of the log, numbered player options
 * below (click or Digit1-9 while THIS window is focused — capture-phase, so
 * toolbar ability binds never fire into a conversation; unfocused = play on).
 * Teach options carry live XP/SP costs; command leaves enqueue the REAL
 * authority commands and the NPC mouths the receipt (ack or honest deny —
 * `DENIED · reason` flashes in the footer, same grammar as every window).
 * Esc / ✕ closes (house). Farewell is always on the root node.
 *
 * Session model: opening a conversation (setConverseTarget) starts a fresh
 * session — greeting re-resolves against live PlayState; the scrollback is
 * session-scoped. Transient window: never restored at boot.
 */

import {
  CONVERSE_WINDOW_ID,
  converseGenerationToken,
  converseTargetActorIdRef,
  converseTargetId,
  setConverseTarget,
} from "./converseWindowIds";
export { CONVERSE_WINDOW_ID, converseTargetId, setConverseTarget };
const STATUS_FLASH_MS = 2600;
const EMPTY_NO_CHANNEL = "NO CHANNEL";
const EMPTY_CHANNEL_CLOSED = "CHANNEL CLOSED";

export interface ConverseWindowDeps {
  sfx: SfxPlayer;
  openWindow: (id: string) => void;
  closeWindow: (id: string) => void;
}

export function createConverseWindowDefinition(deps: ConverseWindowDeps): WindowDefinition {
  return {
    id: CONVERSE_WINDOW_ID,
    title: "CONVERSE",
    icon: "converse",
    hotkey: null,
    minWidth: 460,
    minHeight: 340,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.min(600, Math.max(460, Math.round(viewport.w * 0.34)));
      const h = Math.min(520, Math.max(340, Math.round(viewport.h * 0.5)));
      return { x: Math.round(viewport.w * 0.14), y: Math.round(viewport.h * 0.18), w, h };
    },
    mount: (contentRoot, ctx) => mountConverseContent(contentRoot, ctx, deps),
  };
}

type PendingLeaf =
  | { kind: "train"; skillBoxId: string; boxLabel: string }
  | { kind: "careerGoal"; goalId: string; goalLabel: string }
  | { kind: "starterTool" };

interface ConverseBeat {
  who: "npc" | "you";
  text: string;
}

interface ConverseSession {
  generation: number;
  actorId: string;
  tree: DialogueTree;
  nodeId: string;
  beats: ConverseBeat[];
  /** Receipt voice line standing in for the node line (ack/deny/thinking). */
  overrideLine: string | null;
  inFlight: Map<number, PendingLeaf>;
}

function mountConverseContent(contentRoot: HTMLElement, ctx: WindowContext, deps: ConverseWindowDeps): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scv-root";
  root.innerHTML = `
    <div class="scv-body" data-ref="body">
      <aside class="scv-side">
        <div class="scv-portrait" data-ref="portrait">
          <span class="scv-portrait-initials" data-ref="initials" aria-hidden="true"></span>
        </div>
        <strong class="scv-name" data-ref="name"></strong>
        <span class="scv-role" data-ref="role">TRAINER</span>
      </aside>
      <section class="scv-main">
        <div class="scv-log" data-ref="log" aria-live="polite"></div>
        <div class="scv-options" data-ref="options" role="menu"></div>
      </section>
    </div>
    <div class="scv-empty" data-ref="empty" hidden></div>
    <footer class="scv-foot">
      <span class="scv-status" data-ref="status"></span>
      <span class="scv-range" data-ref="range"></span>
    </footer>
  `;
  contentRoot.appendChild(root);

  const bodyEl = ref(root, "body");
  const portraitEl = ref(root, "portrait");
  const initialsEl = ref(root, "initials");
  const nameEl = ref(root, "name");
  const logEl = ref(root, "log");
  const optionsEl = ref(root, "options");
  const emptyEl = ref(root, "empty");
  const statusEl = ref(root, "status");
  const rangeEl = ref(root, "range");

  let session: ConverseSession | null = null;
  let portrait: NpcPortraitHandle | null = null;
  let renderKey = "";
  let statusFlashTimer = 0;
  let statusPersistent = "";

  const flashStatus = (text: string, deny: boolean): void => {
    statusEl.textContent = text;
    statusEl.toggleAttribute("data-flash", true);
    if (deny) deps.sfx.play(successorAudioIds.uiDeny);
    window.clearTimeout(statusFlashTimer);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.toggleAttribute("data-flash", false);
      statusEl.textContent = statusPersistent;
    }, STATUS_FLASH_MS);
  };

  const setPersistentStatus = (text: string): void => {
    statusPersistent = text;
    if (!statusEl.hasAttribute("data-flash")) statusEl.textContent = text;
  };

  /** Engine ctx — the 3D client injects its identity-aware container scope. */
  const dialogueCtxFor = (npc: DialogueNpc): DialogueCtx => ({
    state,
    slice,
    npc,
    isCarriedContainer: (container) => isLocalInventoryContainer(state, container),
  });

  // ── Session lifecycle ────────────────────────────────────────────────────
  const syncSession = (): void => {
    if (session && session.generation === converseGenerationToken()) return;
    portrait?.dispose();
    portrait = null;
    session = null;
    renderKey = "";
    setPersistentStatus("");
    const actorId = converseTargetActorIdRef();
    if (!actorId) return;
    const npc = trainerDialogueNpc(state, slice, actorId);
    if (!npc) return;
    const tree = trainerDialogueTree(npc);
    session = {
      generation: converseGenerationToken(),
      actorId,
      tree,
      nodeId: tree.entry(dialogueCtxFor(npc)),
      beats: [],
      overrideLine: null,
      inFlight: new Map(),
    };
    nameEl.textContent = npc.label.toUpperCase();
    initialsEl.textContent = npc.label
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase())
      .join("");
    portrait = mountNpcPortrait(portraitEl, state, slice, actorId);
  };

  // ── Receipt settle (voice ack / honest deny) ─────────────────────────────
  const settleInFlight = (): void => {
    if (!session || session.inFlight.size === 0) return;
    const log = state.serverAuthority.receiptLog;
    const voice = session.tree.voice;
    for (const [commandId, leaf] of [...session.inFlight]) {
      let accepted: boolean | null = null;
      let reasonCode = "unspecified";
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const receipt = log[i]!;
        if (receipt.commandId !== commandId) continue;
        accepted = receipt.accepted;
        reasonCode = receipt.reasonCode ?? "unspecified";
        break;
      }
      if (accepted === null) {
        const npc = trainerDialogueNpc(state, slice, session.actorId);
        if (npc && leafSettledByContext(dialogueCtxFor(npc), leaf)) accepted = true;
      }
      if (accepted === null) continue;
      session.inFlight.delete(commandId);
      const reasonHuman = reasonCode.replaceAll("_", " ");
      if (accepted) {
        session.overrideLine = leaf.kind === "train"
          ? voice.trainAck(leaf.boxLabel)
          : leaf.kind === "careerGoal"
            ? voice.careerAck(leaf.goalLabel)
            : voice.toolAck();
        setPersistentStatus("");
      } else {
        session.overrideLine = leaf.kind === "train"
          ? voice.trainDeny(reasonHuman)
          : leaf.kind === "careerGoal"
            ? voice.careerDeny(reasonHuman)
            : voice.toolDeny(reasonHuman);
        setPersistentStatus("");
        flashStatus(`DENIED · ${reasonHuman.toUpperCase()}`, true);
      }
    }
  };

  // ── Dispatch ─────────────────────────────────────────────────────────────
  const dispatchAction = (action: DialogueAction, optionLabel: string, npc: DialogueNpc, resolved: ResolvedNode): void => {
    if (!session) return;
    const currentLine = session.overrideLine ?? resolved.line;
    if (action.kind === "goto") {
      session.beats.push({ who: "npc", text: currentLine }, { who: "you", text: optionLabel });
      session.nodeId = action.nodeId;
      session.overrideLine = null;
      deps.sfx.play("ui_button_tick");
      return;
    }
    if (action.kind === "end") {
      deps.sfx.play("ui_button_tick");
      deps.closeWindow(CONVERSE_WINDOW_ID);
      return;
    }
    if (action.kind === "openWindow") {
      session.beats.push({ who: "npc", text: currentLine }, { who: "you", text: optionLabel });
      deps.sfx.play("ui_button_tick");
      deps.openWindow(action.windowId);
      return;
    }
    const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    if (action.kind === "train") {
      const queued = enqueueAuthorityPurchaseSkillBoxCommand(state.authorityCommands, action.skillBoxId, npc.actorId, issuedAtTick);
      if (!queued) {
        flashStatus("COMMAND NOT QUEUED", true);
        return;
      }
      const boxLabel = skillNodeDefinitions.find((node) => node.id === action.skillBoxId)?.label ?? action.skillBoxId;
      session.beats.push({ who: "npc", text: currentLine }, { who: "you", text: optionLabel });
      session.overrideLine = "\u2026";
      session.inFlight.set(queued.command_id, { kind: "train", skillBoxId: action.skillBoxId, boxLabel });
      setPersistentStatus(`TRAINING ${boxLabel.toUpperCase()}\u2026`);
      deps.sfx.play("ui_button_tick");
      return;
    }
    if (action.kind === "careerGoal") {
      const queued = enqueueAuthoritySetCareerGoalCommand(state.authorityCommands, action.goalId, npc.actorId, issuedAtTick);
      if (!queued) {
        flashStatus("COMMAND NOT QUEUED", true);
        return;
      }
      const goalLabel = action.goalId.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
      session.beats.push({ who: "npc", text: currentLine }, { who: "you", text: optionLabel });
      session.overrideLine = "\u2026";
      session.inFlight.set(queued.command_id, { kind: "careerGoal", goalId: action.goalId, goalLabel });
      setPersistentStatus(`SETTING COURSE\u2026`);
      deps.sfx.play("ui_button_tick");
      return;
    }
    // starterTool — LIVE contract (CraftSimW67 CONTRACTS-LIVE): same trainer
    // gate as PurchaseSkillBox; the seam module owns the wire shape.
    const request = enqueueStarterToolRequest(state, slice, npc.actorId);
    if (request.commandId === null) {
      flashStatus("COMMAND NOT QUEUED", true);
      return;
    }
    session.beats.push({ who: "npc", text: currentLine }, { who: "you", text: optionLabel });
    session.overrideLine = "\u2026";
    session.inFlight.set(request.commandId, { kind: "starterTool" });
    setPersistentStatus("REQUISITION SENT\u2026");
    deps.sfx.play("ui_button_tick");
  };

  // ── Option interaction (click + focused-window digits) ──────────────────
  optionsEl.addEventListener("click", (event: MouseEvent) => {
    const btn = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-option]") : null;
    if (!btn || !session) return;
    const npc = trainerDialogueNpc(state, slice, session.actorId);
    if (!npc) return;
    const dialogueCtx = dialogueCtxFor(npc);
    if (btn.getAttribute("aria-disabled") === "true") {
      flashStatus((btn.dataset.note || "UNAVAILABLE").toUpperCase(), true);
      return;
    }
    const resolved = resolveNode(session.tree, session.nodeId, dialogueCtx);
    const option = resolved.options.find((candidate) => candidate.id === btn.dataset.option);
    if (!option || !option.enabled) return;
    dispatchAction(option.action, option.label, npc, resolved);
    renderKey = "";
  });

  const onDigitCapture = (event: KeyboardEvent): void => {
    if (!event.code.startsWith("Digit") || event.repeat) return;
    if (isTextInputTarget(event.target)) return;
    const windowEl = root.closest<HTMLElement>(".sc3d-window");
    if (!windowEl || windowEl.hidden || !windowEl.hasAttribute("data-focused")) return;
    const index = Number(event.code.slice(5)) - 1;
    if (index < 0 || Number.isNaN(index)) return;
    const buttons = optionsEl.querySelectorAll<HTMLButtonElement>("[data-option]");
    const btn = buttons[index];
    if (!btn) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    btn.click();
  };
  window.addEventListener("keydown", onDigitCapture, { capture: true });

  // ── Render ───────────────────────────────────────────────────────────────
  const showEmpty = (text: string | null): void => {
    emptyEl.hidden = text === null;
    bodyEl.style.visibility = text === null ? "visible" : "hidden";
    if (text !== null) emptyEl.textContent = text;
  };

  const rebuild = (resolved: ResolvedNode, currentLine: string): void => {
    logEl.textContent = "";
    if (!session) return;
    for (const beat of session.beats) {
      const row = document.createElement("div");
      row.className = "scv-beat";
      row.dataset.who = beat.who;
      row.textContent = beat.who === "you" ? `\u203A ${beat.text}` : beat.text;
      logEl.appendChild(row);
    }
    const current = document.createElement("div");
    current.className = "scv-beat scv-current";
    current.dataset.who = "npc";
    current.textContent = currentLine;
    logEl.appendChild(current);
    logEl.scrollTop = logEl.scrollHeight;

    optionsEl.textContent = "";
    resolved.options.forEach((option, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scv-option";
      btn.dataset.option = option.id;
      btn.setAttribute("role", "menuitem");
      const key = document.createElement("kbd");
      key.textContent = index < 9 ? String(index + 1) : "\u00B7";
      const label = document.createElement("span");
      label.textContent = option.label;
      btn.append(key, label);
      if (!option.enabled) {
        btn.setAttribute("aria-disabled", "true");
        btn.dataset.note = option.note ?? "";
        if (option.note) btn.title = option.note;
        const glyph = document.createElement("span");
        glyph.className = "scv-option-lock";
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = "\u25CC";
        btn.appendChild(glyph);
      }
      optionsEl.appendChild(btn);
    });
  };

  return {
    update(): void {
      syncSession();
      if (!session) {
        showEmpty(EMPTY_NO_CHANNEL);
        rangeEl.textContent = "";
        return;
      }
      const npc = trainerDialogueNpc(state, slice, session.actorId);
      if (!npc) {
        showEmpty(EMPTY_CHANNEL_CLOSED);
        rangeEl.textContent = "";
        return;
      }
      showEmpty(null);
      settleInFlight();
      const dialogueCtx = dialogueCtxFor(npc);
      const resolved = resolveNode(session.tree, session.nodeId, dialogueCtx);
      const currentLine = session.overrideLine ?? resolved.line;
      const key = [
        session.generation,
        session.nodeId,
        currentLine,
        session.beats.length,
        npc.inRange ? "in" : "out",
        resolved.options.map((option) => `${option.id}:${option.enabled ? 1 : 0}:${option.note ?? ""}:${option.label}`).join("|"),
      ].join("\u0000");
      if (key !== renderKey) {
        renderKey = key;
        rebuild(resolved, currentLine);
      }
      const rangeText = npc.inRange ? npc.label.toUpperCase() : "TOO FAR · MOVE CLOSER";
      if (rangeEl.textContent !== rangeText) {
        rangeEl.textContent = rangeText;
        rangeEl.toggleAttribute("data-missing", !npc.inRange);
      }
    },
    onResized(): void {
      logEl.scrollTop = logEl.scrollHeight;
    },
    dispose(): void {
      window.removeEventListener("keydown", onDigitCapture, { capture: true });
      window.clearTimeout(statusFlashTimer);
      portrait?.dispose();
      root.remove();
    },
  };
}

/** Receipt-eviction safety net: the world already shows the leaf landed. */
function leafSettledByContext(ctx: DialogueCtx, leaf: PendingLeaf): boolean {
  const actor = playerActor(ctx.state);
  if (!actor) return false;
  if (leaf.kind === "train") return skillBoxTrained(ctx.state, leaf.skillBoxId);
  if (leaf.kind === "careerGoal") return actor.careerGoalId === leaf.goalId;
  return holdsAllOwnedOrExchangeItems(ctx, STARTER_TOOL_ITEM_IDS);
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`converse window: missing data-ref="${name}"`);
  return el;
}
