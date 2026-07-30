import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCloneRespawnCommand,
  enqueueAuthorityPeaceCommand,
  enqueueAuthorityQueueCombatActionCommand,
  enqueueAuthoritySetPostureCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { activeWeaponSpec, reloadActiveWeaponAuthoritative } from "@successor/client/src/slice-core/loadoutSystem";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import type { UiIconId } from "../icons";
import { recordInputEvent } from "../../debug/inputRecorder";

/**
 * TOOLBAR ACTION REGISTRY — the bindable verb set for the 12-slot bar.
 *
 * Two kinds:
 *   verb   — enqueues an authority command (or local weapon op) immediately;
 *            hotkeys and clicks are both live in the always-cursor UI.
 *   window — opens a managed window directly.
 *
 * Each action carries an `icon` (stroke glyph) and a one-line `description`
 * for the Action Browser. Slots render the icon only (no text); the name
 * lives in the slot's tooltip/title. `execute` returns a short receipt for
 * the toolbar flash line (null receipt via ok:false plays the deny tone).
 */
export interface ToolbarActionContext {
  state: PlayState;
  slice: SliceSnapshot;
  sfx: SfxPlayer;
  openWindow: (id: string) => void;
}

export interface ToolbarActionResult {
  ok: boolean;
  receipt: string;
}

export interface ToolbarAction {
  id: string;
  /** Full label — slot tooltip + Action Browser name. */
  label: string;
  /** Stroke glyph rendered in the slot and the browser row. */
  icon: UiIconId;
  /** One-line Action Browser description (hover/secondary text). */
  description: string;
  kind: "verb" | "window";
  execute: (ctx: ToolbarActionContext) => ToolbarActionResult;
}

const issueTick = (ctx: ToolbarActionContext): number =>
  authorityIssuedAtServerTick(ctx.state, ctx.slice.tickRateHz, ctx.slice.tick);

/**
 * Attack = "fire/strike with the equipped weapon against the current soft-
 * lock target." Today that resolves to the roll-combat basic_shot path;
 * the verb naming + semantics stay weapon-agnostic so a melee slot can
 * replace basic_shot server-side without a UI change.
 */
function attackWithEquipped(ctx: ToolbarActionContext): ToolbarActionResult {
  const targetId = ctx.state.softLockActorId;
  if (!targetId) return { ok: false, receipt: "NO TARGET" };
  const queued = enqueueAuthorityQueueCombatActionCommand(ctx.state.authorityCommands, "basic_shot", targetId, issueTick(ctx));
  if (!queued) return { ok: false, receipt: "QUEUE FULL" };
  recordInputEvent({
    kind: "command",
    actorId: targetId,
    routed: "toolbarAttack",
    commandKind: "basic_shot",
    source: "ability",
  });
  return { ok: true, receipt: "ATTACK QUEUED" };
}

function posture(ctx: ToolbarActionContext, posture: "kneel" | "stand", gerund: string): ToolbarActionResult {
  const queued = enqueueAuthoritySetPostureCommand(ctx.state.authorityCommands, posture, issueTick(ctx));
  return queued ? { ok: true, receipt: gerund } : { ok: false, receipt: `${posture.toUpperCase()} DENIED` };
}

function windowAction(windowId: string, icon: UiIconId, label: string, description: string): ToolbarAction {
  return {
    id: `window:${windowId}`,
    label,
    icon,
    description,
    kind: "window",
    execute: (ctx) => {
      ctx.openWindow(windowId);
      return { ok: true, receipt: label.toUpperCase() };
    },
  };
}

export const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
  {
    id: "attack",
    label: "Attack",
    icon: "crosshair",
    description: "Strike the current target with your equipped weapon. Re-engages after a stand-down.",
    kind: "verb",
    execute: attackWithEquipped,
  },
  {
    id: "kneel",
    label: "Kneel",
    icon: "kneel",
    description: "Drop to a knee (posture).",
    kind: "verb",
    execute: (ctx) => posture(ctx, "kneel", "KNEELING"),
  },
  {
    id: "stand",
    label: "Stand",
    icon: "stand",
    description: "Return to a standing posture.",
    kind: "verb",
    execute: (ctx) => posture(ctx, "stand", "STANDING"),
  },
  {
    id: "survey",
    label: "Tool survey",
    icon: "survey",
    description: "Choose a resource family to map. Requires Craftsman training and the matching survey tool.",
    kind: "window",
    execute: (ctx) => {
      ctx.openWindow("surveyTool");
      return { ok: true, receipt: "RESOURCE TARGETING" };
    },
  },
  {
    id: "sample",
    label: "Hand sample",
    icon: "sample",
    description: "Choose a resource family and work a small sample loose. No profession or tool required.",
    kind: "window",
    execute: (ctx) => {
      ctx.openWindow("surveyTool");
      return { ok: true, receipt: "RESOURCE TARGETING" };
    },
  },
  {
    id: "reload",
    label: "Reload",
    icon: "reload",
    description: "Reload your equipped weapon.",
    kind: "verb",
    execute: (ctx) => {
      const spec = activeWeaponSpec(ctx.state);
      const reloaded = reloadActiveWeaponAuthoritative(ctx.state, ctx.slice);
      if (spec && reloaded) ctx.sfx.play(spec.reloadSfx);
      return reloaded ? { ok: true, receipt: "RELOADING" } : { ok: false, receipt: "RELOAD DENIED" };
    },
  },
  {
    id: "peace",
    label: "Stand down",
    icon: "peace",
    description: "Cease auto-fire and disengage.",
    kind: "verb",
    execute: (ctx) => {
      const queued = enqueueAuthorityPeaceCommand(ctx.state.authorityCommands, issueTick(ctx));
      return queued ? { ok: true, receipt: "STANDING DOWN" } : { ok: false, receipt: "PEACE DENIED" };
    },
  },
  {
    id: "clone",
    label: "Activate clone",
    icon: "clone",
    description: "Respawn at the nearest clone facility.",
    kind: "verb",
    execute: (ctx) => {
      const queued = enqueueAuthorityCloneRespawnCommand(ctx.state.authorityCommands, issueTick(ctx));
      return queued ? { ok: true, receipt: "CLONE ACTIVATION QUEUED" } : { ok: false, receipt: "CLONE DENIED" };
    },
  },
  // Window shortcuts cover the PERMANENT dock destinations only (context
  // surfaces like the survey scope open from their item/device routes;
  // removed ids fall out of stale persisted slots via the migration gate).
  windowAction("inventory", "inventory", "Inventory", "Open your field kit."),
  windowAction("character", "character", "Character", "Open your character sheet."),
  windowAction("skills", "skills", "Skills", "Open the profession skill tree."),
  windowAction("datapad", "datapad", "Datapad", "Open the field datapad."),
  windowAction("macros", "macro", "Macros", "Open the macro bench — author and run command scripts."),
  windowAction("options", "options", "Options", "Open display + input options."),
];

const ACTION_BY_ID: Record<string, ToolbarAction> = TOOLBAR_ACTIONS.reduce<Record<string, ToolbarAction>>(
  (acc, action) => {
    acc[action.id] = action;
    return acc;
  },
  {},
);

export function toolbarActionById(id: string | null | undefined): ToolbarAction | null {
  if (!id) return null;
  return ACTION_BY_ID[id] ?? null;
}

/** Whether `id` is a registered toolbar action — the Aim-strip migration gate. */
export function isToolbarActionId(id: string): boolean {
  return id in ACTION_BY_ID;
}

/**
 * Default hotkey code per slot — the number row 1-= (owner spec). Slots
 * start EMPTY; the player populates them from the Action Browser.
 */
export const TOOLBAR_DEFAULT_BINDS: readonly string[] = [
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Digit0",
  "Minus",
  "Equal",
];
