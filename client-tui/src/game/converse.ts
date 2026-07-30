/**
 * /converse — classic MUD dialogue over the shared tree engine.
 *
 * The shared dialogue engine
 * resolves nodes to numbered options with honest deny notes; this module
 * owns the SESSION: one fresh conversation per open (host-owned rule),
 * bare-digit selection, range-exit beats, and receipt phrasing through the
 * tree's per-persona voice (with the raw `DENIED · reason` grammar kept).
 */

import {
  resolveNode,
  trainerDialogueNpc,
  type DialogueCtx,
  type DialogueNpc,
  type DialogueTree,
  type ResolvedNode,
} from "@successor/client/src/slice-core/dialogue/dialogueTree";
import { trainerDialogueTree } from "@successor/client/src/slice-core/dialogue/trainerScripts";
import {
  STARTER_TOOL_CONTRACT_LIVE,
  STARTER_TOOL_PENDING_NOTE,
  enqueueStarterToolRequest,
} from "@successor/client/src/slice-core/dialogue/starterToolLeaf";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityPurchaseSkillBoxCommand,
  enqueueAuthoritySetCareerGoalCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { professionTrainerInteractionRadiusCells } from "@successor/client/src/slice-core/professionTrainerSystem";

import { isCarriedContainer } from "./exchangeTrade";

/** Session-identity ids the ctx gate folds in (playerId/characterId). */
export type CarriedGate = (container: string) => boolean;

export interface ConverseLine {
  register: string;
  text: string;
}

/** Receipt kinds a live conversation phrases through its persona voice. */
export const CONVERSE_RECEIPT_KINDS = ["PurchaseSkillBox", "SetCareerGoal", "RequestStarterTool"] as const;

export interface ConverseSession {
  open(token: string | undefined): ConverseLine[];
  /** True while a conversation renders (digit selection active). */
  active(): boolean;
  /** Select a numbered option (1..n); 0 leaves. */
  select(index: number): ConverseLine[];
  /** Distance watchdog — call on a coarse cadence; speaks the exit beat. */
  tick(): ConverseLine[];
  /** Phrase a claimed receipt through the persona voice. */
  phraseReceipt(kind: string, accepted: boolean, reasonCode: string | undefined): ConverseLine[];
  end(): void;
}

interface LiveConversation {
  tree: DialogueTree;
  npc: DialogueNpc;
  nodeId: string;
  resolved: ResolvedNode;
  /** Last option kind awaiting a receipt (voice pick). */
  pendingVoice: "train" | "career" | "tool" | null;
  pendingLabel: string;
}

export function createConverseSession(
  state: PlayState,
  slice: SliceSnapshot,
  isCarried: CarriedGate = (container) => isCarriedContainer(state, container),
): ConverseSession {
  let live: LiveConversation | null = null;

  const ctx = (npc: DialogueNpc): DialogueCtx => ({
    state,
    slice,
    npc,
    isCarriedContainer: isCarried,
  });

  const refreshNpc = (npc: DialogueNpc): DialogueNpc | null =>
    trainerDialogueNpc(state, slice, npc.actorId);

  const renderNode = (conversation: LiveConversation): ConverseLine[] => {
    const lines: ConverseLine[] = [
      { register: "dialogue", text: `⟨${conversation.npc.label}⟩ "${conversation.resolved.line}"` },
    ];
    conversation.resolved.options.forEach((option, index) => {
      const number = index + 1;
      if (option.enabled) {
        lines.push({ register: "dialogue", text: ` ${number}. ${option.label}` });
      } else {
        lines.push({ register: "system", text: ` ${number}. ${option.label} — ${option.note ?? "not now"}` });
      }
    });
    lines.push({ register: "system", text: " 0. Leave." });
    return lines;
  };

  const endBeat = (label: string): ConverseLine => ({
    register: "world",
    text: `${label} turns back to their work.`,
  });

  return {
    open(token) {
      const npc = findTrainerNpc(state, slice, token);
      if (!npc) return [{ register: "reject", text: "No one here answers to that — find a trainer first." }];
      if (!npc.inRange) {
        return [{ register: "system", text: `${npc.label} is ${npc.distanceCells.toFixed(1)}c off — step within ${professionTrainerInteractionRadiusCells}c to talk.` }];
      }
      const tree = trainerDialogueTree(npc);
      const context = ctx(npc);
      const nodeId = tree.entry(context);
      live = {
        tree,
        npc,
        nodeId,
        resolved: resolveNode(tree, nodeId, context),
        pendingVoice: null,
        pendingLabel: "",
      };
      return renderNode(live);
    },
    active() {
      return live !== null;
    },
    select(index) {
      if (!live) return [];
      if (index === 0) {
        const label = live.npc.label;
        live = null;
        return [endBeat(label)];
      }
      const option = live.resolved.options[index - 1];
      if (!option) return [{ register: "system", text: `There is no ${index} on offer.` }];
      if (!option.enabled) {
        return [{ register: "system", text: `${option.label} — ${option.note ?? "not now"}` }];
      }
      const echo: ConverseLine = { register: "echo", text: `» ${option.label}` };
      const action = option.action;
      switch (action.kind) {
        case "goto": {
          live.nodeId = action.nodeId;
          live.resolved = resolveNode(live.tree, live.nodeId, ctx(live.npc));
          return [echo, ...renderNode(live)];
        }
        case "end": {
          const label = live.npc.label;
          live = null;
          return [echo, endBeat(label)];
        }
        case "train": {
          const queued = enqueueAuthorityPurchaseSkillBoxCommand(
            state.authorityCommands,
            action.skillBoxId,
            live.npc.actorId,
            authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
          );
          live.pendingVoice = "train";
          live.pendingLabel = subjectLabelOf(option.label);
          return queued
            ? [echo]
            : [echo, { register: "reject", text: "The request never leaves your mouth — try again." }];
        }
        case "careerGoal": {
          const queued = enqueueAuthoritySetCareerGoalCommand(
            state.authorityCommands,
            action.goalId,
            live.npc.actorId,
            authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
          );
          live.pendingVoice = "career";
          live.pendingLabel = subjectLabelOf(option.label);
          return queued ? [echo] : [echo, { register: "reject", text: "That thought stays unspoken — try again." }];
        }
        case "starterTool": {
          if (!STARTER_TOOL_CONTRACT_LIVE) {
            return [echo, { register: "system", text: `${STARTER_TOOL_PENDING_NOTE}.` }];
          }
          enqueueStarterToolRequest(state, slice, live.npc.actorId);
          live.pendingVoice = "tool";
          live.pendingLabel = option.label;
          return [echo];
        }
        case "openWindow": {
          return [echo, { register: "system", text: windowHint(action.windowId) }];
        }
      }
    },
    tick() {
      if (!live) return [];
      const refreshed = refreshNpc(live.npc);
      if (refreshed && refreshed.inRange) {
        live.npc = refreshed;
        return [];
      }
      const label = live.npc.label;
      live = null;
      return [endBeat(label)];
    },
    phraseReceipt(kind, accepted, reasonCode) {
      if (!live || !live.pendingVoice) return [];
      const voice = live.tree.voice;
      const pending = live.pendingVoice;
      live.pendingVoice = null;
      const label = live.pendingLabel;
      const reason = reasonCode ?? "unspecified";
      let text: string;
      if (pending === "train" && kind === "PurchaseSkillBox") {
        text = accepted ? voice.trainAck(label) : `${voice.trainDeny(reason)} — DENIED · ${reason.replaceAll("_", " ").toUpperCase()}`;
      } else if (pending === "career" && kind === "SetCareerGoal") {
        text = accepted ? voice.careerAck(label) : `${voice.careerDeny(reason)} — DENIED · ${reason.replaceAll("_", " ").toUpperCase()}`;
      } else if (pending === "tool" && kind === "RequestStarterTool") {
        text = accepted ? voice.toolAck() : `${voice.toolDeny(reason)} — DENIED · ${reason.replaceAll("_", " ").toUpperCase()}`;
      } else {
        return [];
      }
      const lines: ConverseLine[] = [{ register: "dialogue", text: `⟨${live.npc.label}⟩ "${text}"` }];
      // refresh the node — costs/availability may have changed with the receipt
      live.resolved = resolveNode(live.tree, live.nodeId, ctx(live.npc));
      lines.push(...renderNode(live));
      return lines;
    },
    end() {
      live = null;
    },
  };
}

/**
 * Nearest (or named) profession trainer. Trainer identity lives on SLICE
 * actors (professionTrainerSystem candidates); positions prefer the AOI
 * stream when the trainer is in scope.
 */
function findTrainerNpc(state: PlayState, slice: SliceSnapshot, token: string | undefined): DialogueNpc | null {
  const needle = token?.trim().toLowerCase() ?? "";
  let best: DialogueNpc | null = null;
  for (const actor of slice.actors) {
    const npc = trainerDialogueNpc(state, slice, actor.id);
    if (!npc) continue;
    if (needle && !npc.label.toLowerCase().includes(needle) && npc.actorId.toLowerCase() !== needle) continue;
    if (!best || npc.distanceCells < best.distanceCells) best = npc;
  }
  return best;
}

function windowHint(windowId: string): string {
  const hints: Record<string, string> = {
    skills: "(A gesture at the board — /skills ground is covered by /help train and the trainer's own list.)",
    character: "(That story lives in /vitals and /inv here.)",
  };
  return hints[windowId] ?? `(The ${windowId} board has no terminal twin yet — the trainer's list covers it.)`;
}

/**
 * Teach labels read "PROFESSION · NAME · COST…" (teachOptionLabel); the
 * persona ack should speak the NAME, not the ledger line.
 */
function subjectLabelOf(label: string): string {
  const parts = label.split(" · ");
  return parts.length >= 3 ? parts[1]! : parts[0]!;
}
