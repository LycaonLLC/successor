import { authorityIssuedAtServerTick, enqueueAuthorityCommand } from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, ServerAuthorityGroupMemberFrameState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

/**
 * GROUP HUD — the minimal invite toast + member rail (fe-polish §1.29 ruled
 * scope: the wire state landed with GroupsSim, but the invited client
 * rendered NOTHING anywhere — the single worst player-blindness in the
 * audit).
 *
 *  - INVITE TOAST: while `group.pendingInvite` rides the view, a top-center
 *    banner names the inviter with JOIN / DECLINE — the same GroupAccept/
 *    GroupDecline commands `/group-accept` routes. It never times out
 *    client-side; the server expires the invite and the view drops it.
 *  - MEMBER RAIL: while grouped, one compact chip per OTHER member under the
 *    player plate — leader pip, clean name, health sliver, DOWN/LD tag.
 *    Self stays on the status plate (no duplicate gauge chrome).
 *
 * Reads the owning-session-safe group channel every frame; diff-gated DOM
 * writes (statusPlate pattern). Probe surface: `window.__successor3dGroupHud`.
 */
export interface GroupHudController {
  dispose: () => void;
}

const MAX_MEMBER_CHIPS = 5;

interface GroupHudProbeWindow {
  __successor3dGroupHud?: {
    invite: string | null;
    memberCount: number;
    memberIds: string[];
  } | null;
}

export function mountGroupHud(shell: HTMLElement, state: PlayState, slice: SliceSnapshot): GroupHudController {
  // ── Invite toast ─────────────────────────────────────────────────────────
  const toast = document.createElement("aside");
  toast.className = "sc3d-group-invite";
  toast.hidden = true;
  toast.innerHTML = `
    <span class="sc3d-group-invite-line"><b data-ref="inviter">—</b> WANTS YOU IN THE PARTY</span>
    <span class="sc3d-group-invite-ctas">
      <button type="button" class="sc3d-group-btn sc3d-group-btn--join" data-ref="join">JOIN</button>
      <button type="button" class="sc3d-group-btn" data-ref="decline">DECLINE</button>
    </span>
  `;
  shell.appendChild(toast);
  const inviterEl = ref(toast, "inviter");
  const joinBtn = ref(toast, "join") as HTMLButtonElement;
  const declineBtn = ref(toast, "decline") as HTMLButtonElement;

  const answer = (accept: boolean): void => {
    enqueueAuthorityCommand(
      state.authorityCommands,
      accept ? { GroupAccept: {} } : { GroupDecline: {} },
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    // The view's pendingInvite clears on the authoritative answer; hide
    // eagerly so a double-click can't queue twice.
    toast.hidden = true;
    appliedInviter = null;
  };
  joinBtn.addEventListener("click", () => answer(true));
  declineBtn.addEventListener("click", () => answer(false));

  // ── Member rail ──────────────────────────────────────────────────────────
  const rail = document.createElement("aside");
  rail.className = "sc3d-group-rail";
  rail.hidden = true;
  rail.setAttribute("aria-label", "Group members");
  shell.appendChild(rail);

  interface ChipNodes {
    root: HTMLElement;
    name: HTMLElement;
    fill: HTMLElement;
    tag: HTMLElement;
    applied: { name: string; percent: number; tag: string; leader: boolean | null; down: boolean | null };
  }
  const chips: ChipNodes[] = [];
  let overflowEl: HTMLElement | null = null;

  const buildChip = (): ChipNodes => {
    const root = document.createElement("div");
    root.className = "sc3d-group-chip";
    root.innerHTML = `
      <span class="sc3d-group-chip-head">
        <span class="sc3d-group-chip-name" data-ref="name"></span>
        <span class="sc3d-group-chip-tag" data-ref="tag" hidden></span>
      </span>
      <span class="sc3d-group-chip-track"><span class="sc3d-group-chip-fill" data-ref="fill"></span></span>
    `;
    rail.appendChild(root);
    return {
      root,
      name: ref(root, "name"),
      fill: ref(root, "fill"),
      tag: ref(root, "tag"),
      applied: { name: "", percent: -1, tag: "\u0000", leader: null, down: null },
    };
  };

  const applyChip = (chip: ChipNodes, member: ServerAuthorityGroupMemberFrameState): void => {
    if (chip.applied.name !== member.name) {
      chip.applied.name = member.name;
      chip.name.textContent = member.name;
    }
    if (chip.applied.leader !== member.isLeader) {
      chip.applied.leader = member.isLeader;
      chip.root.toggleAttribute("data-leader", member.isLeader);
    }
    const down = member.lifeState !== "alive";
    if (chip.applied.down !== down) {
      chip.applied.down = down;
      chip.root.toggleAttribute("data-down", down);
    }
    const tag = member.linkDead ? "LD" : down ? "DOWN" : "";
    if (chip.applied.tag !== tag) {
      chip.applied.tag = tag;
      chip.tag.textContent = tag;
      chip.tag.hidden = tag === "";
    }
    const max = member.maxVitals.health;
    const percent = max > 0 ? Math.round(Math.max(0, Math.min(100, (member.vitals.health / max) * 100))) : 0;
    if (chip.applied.percent !== percent) {
      chip.applied.percent = percent;
      chip.fill.style.width = `${percent}%`;
      chip.root.toggleAttribute("data-low", percent <= 25);
    }
  };

  let appliedInviter: string | null = null;
  let railVisible = false;
  let appliedOverflow = -1;

  let frameId = 0;
  const frame = (): void => {
    frameId = requestAnimationFrame(frame);
    const view = state.serverAuthority.group;
    const playerId = state.serverAuthority.playerActorId ?? state.playerActorId;

    // Invite toast (only while NOT already grouped — the server enforces it,
    // the HUD just never shows both).
    const invite = view.pendingInvite ?? null;
    const inviterName = invite && (view.members.length === 0) ? (invite.inviterName || invite.inviterActorId) : null;
    if (appliedInviter !== inviterName) {
      appliedInviter = inviterName;
      toast.hidden = inviterName === null;
      if (inviterName !== null) inviterEl.textContent = inviterName.toUpperCase();
    }

    // Member rail — every member but self, leader first (wire order kept
    // otherwise), capped with an honest overflow count.
    const others = view.members.filter((member) => member.actorId !== playerId);
    const visible = others.length > 0;
    if (railVisible !== visible) {
      railVisible = visible;
      rail.hidden = !visible;
    }
    publishProbe(inviterName, view.members.length, others);
    if (!visible) return;
    const shown = others.slice(0, MAX_MEMBER_CHIPS);
    while (chips.length < shown.length) chips.push(buildChip());
    while (chips.length > shown.length) {
      chips.pop()?.root.remove();
    }
    for (let i = 0; i < shown.length; i += 1) applyChip(chips[i]!, shown[i]!);
    const overflow = others.length - shown.length;
    if (appliedOverflow !== overflow) {
      appliedOverflow = overflow;
      if (overflow > 0) {
        if (!overflowEl) {
          overflowEl = document.createElement("div");
          overflowEl.className = "sc3d-group-overflow";
          rail.appendChild(overflowEl);
        }
        overflowEl.textContent = `+${overflow} MORE`;
        overflowEl.hidden = false;
      } else if (overflowEl) {
        overflowEl.hidden = true;
      }
    }
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose(): void {
      cancelAnimationFrame(frameId);
      toast.remove();
      rail.remove();
      publishProbe(null, 0, []);
    },
  };
}

function publishProbe(invite: string | null, memberCount: number, others: readonly ServerAuthorityGroupMemberFrameState[]): void {
  if (typeof window === "undefined") return;
  (window as unknown as GroupHudProbeWindow).__successor3dGroupHud = {
    invite,
    memberCount,
    memberIds: others.map((member) => member.actorId),
  };
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`group hud: missing data-ref="${name}"`);
  return el;
}
