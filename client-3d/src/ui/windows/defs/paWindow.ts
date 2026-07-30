import {
  authorityIssuedAtServerTick,
  enqueueAuthorityGuildAcceptInviteCommand,
  enqueueAuthorityGuildAcceptWarCommand,
  enqueueAuthorityGuildCreateCommand,
  enqueueAuthorityGuildDeclareWarCommand,
  enqueueAuthorityGuildDeclineInviteCommand,
  enqueueAuthorityGuildDisbandCommand,
  enqueueAuthorityGuildKickCommand,
  enqueueAuthorityGuildLeaveCommand,
  enqueueAuthorityGuildRescindWarCommand,
  enqueueAuthorityGuildSetPermissionsCommand,
  enqueueAuthorityGuildSetRoleCommand,
  enqueueAuthorityGuildTransferLeadershipCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type {
  PlayState,
  ServerAuthorityGuildPermission,
  ServerAuthorityGuildRosterEntryState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  GUILD_CHARTER_FEE_CREDITS,
  GUILD_PERMISSIONS,
  GUILD_TERMINAL_REACH_CELLS,
  guildPermissionsToMask,
  hasGuildPermission,
  isGuildLeader,
  localGuildRosterEntry,
} from "@successor/client/src/slice-core/guildSystem";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import { createRejectWatcher } from "./commandReceipts";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * ASSOCIATION — the Player Association (guild) management window.
 *
 * Journey: the PA terminal (kiosk grammar: single-LMB screen, radial, F-chip)
 * is the CHARTER desk — founding needs the terminal in reach and the exact
 * 250,000-credit fee on hand. Everything after founding is normal game UI:
 * the dock button / G hotkey / `/ui association` open the same window
 * anywhere, because managing a roster should never require walking back to
 * a kiosk.
 *
 * Facts come ONLY from the server-verified `authority.guilds` projection:
 * membership, roster presence (area only while online, last-seen age when
 * offline), permission grants, wars, invites, and the public directory.
 * Every verb is an authority command; the server re-validates regardless of
 * the client gates, and rejects flash verbatim reason codes in the foot.
 */

import {
  activePaTerminal,
  PA_WINDOW_ID,
  setActivePaTerminal,
  type PaWindowChatBridge,
  type PaWindowDeps,
} from "./paWindowIds";
export { activePaTerminal, PA_WINDOW_ID, setActivePaTerminal, type PaWindowChatBridge, type PaWindowDeps };
/** Shared kiosk interaction reach (matches bank/clone terminals). */
const PA_REACH_CELLS = GUILD_TERMINAL_REACH_CELLS;
const STATUS_FLASH_MS = 2600;
const NAME_MAX = 40;
const TAG_MAX = 5;
const GUILD_COMMAND_KINDS = [
  "GuildCreate",
  "GuildInvite",
  "GuildAcceptInvite",
  "GuildDeclineInvite",
  "GuildLeave",
  "GuildKick",
  "GuildSetRole",
  "GuildSetPermissions",
  "GuildTransferLeadership",
  "GuildDeclareWar",
  "GuildAcceptWar",
  "GuildRescindWar",
  "GuildDisband",
] as const;
function paTerminalDistance(state: PlayState, slice: SliceSnapshot, propId: string): number | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[actorId];
  const areaId = me?.areaId ?? state.activeAreaId;
  const x = me?.x ?? state.player.x;
  const y = me?.y ?? state.player.y;
  const prop = slice.props.find((candidate) => candidate.id === propId && candidate.areaId === areaId);
  if (!prop) return null;
  return Math.hypot(x + 0.5 - (prop.cell.x + prop.size.w / 2), y + 0.5 - (prop.cell.y + prop.size.h / 2));
}
export function withinPaTerminalRange(state: PlayState, slice: SliceSnapshot, propId: string): boolean {
  const distance = paTerminalDistance(state, slice, propId);
  return distance !== null && distance <= PA_REACH_CELLS;
}
/** Nearest in-reach PA terminal (dock/hotkey open adopts the one beside you). */
export function nearestPaTerminalInRange(state: PlayState, slice: SliceSnapshot): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const prop of slice.props) {
    if (prop.kind !== "pa_terminal") continue;
    const distance = paTerminalDistance(state, slice, prop.id);
    if (distance !== null && distance <= PA_REACH_CELLS && distance < bestDistance) {
      best = prop.id;
      bestDistance = distance;
    }
  }
  return best;
}

export function createPaWindowDefinition(deps: PaWindowDeps = {}): WindowDefinition {
  return {
    id: PA_WINDOW_ID,
    title: "ASSOCIATION",
    icon: "association",
    hotkey: "KeyG",
    minWidth: 460,
    minHeight: 420,
    defaultBounds: (viewport) => {
      const w = Math.max(460, Math.round(viewport.w * 0.32));
      const h = Math.max(420, Math.round(viewport.h * 0.58));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.4), w, h };
    },
    mount: (contentRoot, ctx) => mountPaWindowContent(contentRoot, ctx, deps),
  };
}

interface ArmedConfirm {
  key: string;
  label: string;
  run: () => void;
}

function mountPaWindowContent(contentRoot: HTMLElement, ctx: WindowContext, deps: PaWindowDeps): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-pa";
  root.innerHTML = `
    <header class="scp-pa-head">
      <span class="scp-pa-link" data-ref="link">NO TERMINAL LINK</span>
      <span class="scp-pa-headnote">PLAYER ASSOCIATION REGISTRY</span>
    </header>
    <div class="scp-pa-scroll" data-ref="scroll">
      <section class="scp-pa-section" data-ref="summarySection" hidden aria-label="Association summary">
        <div class="scp-pa-summary" data-ref="summary"></div>
        <div class="scp-pa-chatrow">
          <input class="scp-pa-input scp-pa-chatinput" data-ref="chatInput" type="text" maxlength="240"
            autocomplete="off" spellcheck="false" aria-label="Guild chat message" placeholder="GUILD CHAT…" />
          <button type="button" class="scp-pa-btn" data-ref="chatSend">SEND</button>
          <button type="button" class="scp-pa-btn" data-ref="chatChannel" title="Switch the chat pane to the GUILD channel">CHANNEL</button>
        </div>
      </section>
      <section class="scp-pa-section" data-ref="inviteSection" hidden aria-label="Association invites">
        <h3 class="scp-pa-title">INVITES</h3>
        <div class="scp-pa-list" data-ref="inviteList" role="list"></div>
      </section>
      <section class="scp-pa-section" data-ref="charterSection" hidden aria-label="Found an association">
        <h3 class="scp-pa-title">CHARTER</h3>
        <div class="scp-pa-charter-grid">
          <label class="scp-pa-field">
            <span class="scp-pa-fieldname">NAME</span>
            <input class="scp-pa-input" data-ref="charterName" type="text" maxlength="${NAME_MAX}"
              autocomplete="off" spellcheck="false" aria-label="Association name" />
          </label>
          <label class="scp-pa-field scp-pa-field-tag">
            <span class="scp-pa-fieldname">TAG</span>
            <input class="scp-pa-input" data-ref="charterTag" type="text" maxlength="${TAG_MAX}"
              autocomplete="off" spellcheck="false" aria-label="Association tag" />
          </label>
        </div>
        <div class="scp-pa-feerow">
          <span>CHARTER FEE</span>
          <span class="scp-pa-fee" data-ref="fee">${GUILD_CHARTER_FEE_CREDITS.toLocaleString()} CR</span>
        </div>
        <div class="scp-pa-feerow scp-pa-feerow-dim">
          <span>FUNDS · VAULT + WALLET</span>
          <span data-ref="funds">—</span>
        </div>
        <div class="scp-pa-termrow" data-ref="termRow">AT PA TERMINAL ONLY · ≤${PA_REACH_CELLS} CELLS</div>
        <button type="button" class="scp-pa-primary" data-ref="found" disabled>FOUND ASSOCIATION</button>
      </section>
      <section class="scp-pa-section" data-ref="rosterSection" hidden aria-label="Member roster">
        <h3 class="scp-pa-title">ROSTER <span class="scp-pa-count" data-ref="rosterCount"></span></h3>
        <div class="scp-pa-list" data-ref="rosterList" role="list"></div>
      </section>
      <section class="scp-pa-section" data-ref="warSection" hidden aria-label="Wars">
        <h3 class="scp-pa-title">WARS</h3>
        <div class="scp-pa-list" data-ref="warList" role="list"></div>
      </section>
      <section class="scp-pa-section" aria-label="Public directory">
        <h3 class="scp-pa-title">DIRECTORY</h3>
        <div class="scp-pa-list" data-ref="directoryList" role="list"></div>
      </section>
      <section class="scp-pa-section scp-pa-footactions" data-ref="memberActions" hidden aria-label="Membership actions">
        <button type="button" class="scp-pa-btn scp-pa-danger" data-ref="leave">LEAVE</button>
        <button type="button" class="scp-pa-btn scp-pa-danger" data-ref="disband" hidden>DISBAND</button>
      </section>
    </div>
    <div class="scp-pa-confirm" data-ref="confirmBar" hidden>
      <span class="scp-pa-confirmlabel" data-ref="confirmLabel"></span>
      <button type="button" class="scp-pa-btn scp-pa-danger" data-ref="confirmYes">CONFIRM</button>
      <button type="button" class="scp-pa-btn" data-ref="confirmNo">CANCEL</button>
    </div>
    <footer class="scp-status-foot">
      <span class="scp-status-line" data-ref="status" role="status" aria-live="polite"></span>
    </footer>
  `;
  contentRoot.appendChild(root);

  const refs = {
    link: mustRef(root, "link"),
    summarySection: mustRef(root, "summarySection"),
    summary: mustRef(root, "summary"),
    chatInput: mustRef(root, "chatInput") as HTMLInputElement,
    chatSend: mustRef(root, "chatSend") as HTMLButtonElement,
    chatChannel: mustRef(root, "chatChannel") as HTMLButtonElement,
    inviteSection: mustRef(root, "inviteSection"),
    inviteList: mustRef(root, "inviteList"),
    charterSection: mustRef(root, "charterSection"),
    charterName: mustRef(root, "charterName") as HTMLInputElement,
    charterTag: mustRef(root, "charterTag") as HTMLInputElement,
    funds: mustRef(root, "funds"),
    termRow: mustRef(root, "termRow"),
    found: mustRef(root, "found") as HTMLButtonElement,
    rosterSection: mustRef(root, "rosterSection"),
    rosterCount: mustRef(root, "rosterCount"),
    rosterList: mustRef(root, "rosterList"),
    warSection: mustRef(root, "warSection"),
    warList: mustRef(root, "warList"),
    directoryList: mustRef(root, "directoryList"),
    memberActions: mustRef(root, "memberActions"),
    leave: mustRef(root, "leave") as HTMLButtonElement,
    disband: mustRef(root, "disband") as HTMLButtonElement,
    confirmBar: mustRef(root, "confirmBar"),
    confirmLabel: mustRef(root, "confirmLabel"),
    confirmYes: mustRef(root, "confirmYes") as HTMLButtonElement,
    confirmNo: mustRef(root, "confirmNo") as HTMLButtonElement,
  };

  const rejectWatcher = createRejectWatcher(state, GUILD_COMMAND_KINDS);

  let statusFlashUntil = 0;
  let renderKey = "";
  let linked = false;
  let linkedTerminalId: string | null = null;
  let armedConfirm: ArmedConfirm | null = null;
  /** Roster row whose permission editor is expanded (actorId), else null. */
  let openPermsFor: string | null = null;
  /** Draft permission set for the open editor. */
  let permsDraft = new Set<ServerAuthorityGuildPermission>();

  const issuedTick = () => authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);

  const flashStatus = (text: string, deny = false): void => {
    const statusEl = mustRef(root, "status");
    statusEl.textContent = text;
    statusEl.toggleAttribute("data-denied", deny);
    statusFlashUntil = performance.now() + STATUS_FLASH_MS;
    if (deny) deps.sfx?.play(successorAudioIds.uiDeny);
  };

  const clearConfirm = (): void => {
    armedConfirm = null;
    refs.confirmBar.hidden = true;
    refs.confirmLabel.textContent = "";
  };

  const armConfirm = (key: string, label: string, run: () => void): void => {
    armedConfirm = { key, label, run };
    refs.confirmLabel.textContent = label;
    refs.confirmBar.hidden = false;
    deps.sfx?.play("ui_button_tick");
    refs.confirmYes.focus();
  };

  refs.confirmYes.addEventListener("click", () => {
    const confirm = armedConfirm;
    clearConfirm();
    confirm?.run();
  });
  refs.confirmNo.addEventListener("click", () => {
    clearConfirm();
  });

  // Esc with an armed confirm CANCELS the confirm (and stops short of the
  // window-manager close); Esc inside a text field just blurs it. This rides
  // the bubble phase on the content root, so it runs before the manager's
  // window-level listener.
  const onRootKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "Escape") return;
    if (armedConfirm) {
      event.preventDefault();
      event.stopPropagation();
      clearConfirm();
      return;
    }
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      event.preventDefault();
      event.stopPropagation();
      target.blur();
    }
  };
  root.addEventListener("keydown", onRootKeyDown);

  // ── Charter ──────────────────────────────────────────────────────────────
  refs.charterTag.addEventListener("input", () => {
    const upper = refs.charterTag.value.toUpperCase().replace(/[^A-Z0-9]/gu, "");
    if (upper !== refs.charterTag.value) refs.charterTag.value = upper;
  });
  refs.found.addEventListener("click", () => {
    const name = refs.charterName.value.trim();
    const tag = refs.charterTag.value.trim();
    if (!linked || !linkedTerminalId) {
      flashStatus(`AT PA TERMINAL ONLY · ≤${PA_REACH_CELLS} CELLS`, true);
      return;
    }
    if (!name || !tag) {
      flashStatus("NAME AND TAG REQUIRED", true);
      return;
    }
    const queued = enqueueAuthorityGuildCreateCommand(
      state.authorityCommands, name, tag, linkedTerminalId, issuedTick(),
    );
    if (queued) {
      deps.sfx?.play(successorAudioIds.itemTransfer);
      flashStatus("FILING CHARTER…");
    }
  });

  // ── Guild chat entry ─────────────────────────────────────────────────────
  const submitChatLine = (): void => {
    const body = refs.chatInput.value.trim();
    if (!body) return;
    if (deps.chat?.sendGuildLine(body)) {
      refs.chatInput.value = "";
      deps.sfx?.play("ui_button_tick");
    } else {
      flashStatus("NO ASSOCIATION CHANNEL", true);
    }
  };
  refs.chatSend.addEventListener("click", submitChatLine);
  refs.chatInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
    event.preventDefault();
    event.stopPropagation();
    submitChatLine();
  });
  refs.chatChannel.addEventListener("click", () => {
    if (deps.chat?.selectGuildChannel()) {
      deps.sfx?.play("ui_button_tick");
      flashStatus("GUILD CHANNEL SELECTED");
    } else {
      flashStatus("NO ASSOCIATION CHANNEL", true);
    }
  });

  // ── Foot membership actions ──────────────────────────────────────────────
  refs.leave.addEventListener("click", () => {
    armConfirm("leave", "LEAVE ASSOCIATION — ROSTER SEAT IS FORFEIT", () => {
      enqueueAuthorityGuildLeaveCommand(state.authorityCommands, issuedTick());
      flashStatus("LEAVING…");
    });
  });
  refs.disband.addEventListener("click", () => {
    armConfirm("disband", "DISBAND ASSOCIATION — CANNOT BE UNDONE", () => {
      enqueueAuthorityGuildDisbandCommand(state.authorityCommands, issuedTick());
      flashStatus("DISBANDING…");
    });
  });

  // ── List actions (delegated: lists re-render, handlers do not) ──────────
  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-act]") : null;
    if (!button || button.disabled) return;
    const act = button.dataset.act!;
    const id = button.dataset.id ?? "";
    const tick = issuedTick();
    switch (act) {
      case "invite-accept":
        enqueueAuthorityGuildAcceptInviteCommand(state.authorityCommands, id, tick);
        deps.sfx?.play("ui_button_tick");
        flashStatus("JOINING…");
        break;
      case "invite-decline":
        enqueueAuthorityGuildDeclineInviteCommand(state.authorityCommands, id, tick);
        deps.sfx?.play("ui_button_tick");
        break;
      case "kick":
        enqueueAuthorityGuildKickCommand(state.authorityCommands, id, tick);
        deps.sfx?.play("ui_button_tick");
        break;
      case "role": {
        const role = button.dataset.role === "officer" ? "officer" : "member";
        enqueueAuthorityGuildSetRoleCommand(state.authorityCommands, id, role, tick);
        deps.sfx?.play("ui_button_tick");
        break;
      }
      case "transfer": {
        const name = button.dataset.name ?? id;
        armConfirm("transfer", `TRANSFER LEADERSHIP TO ${name.toUpperCase()} — YOU STEP DOWN`, () => {
          enqueueAuthorityGuildTransferLeadershipCommand(state.authorityCommands, id, issuedTick());
          flashStatus("TRANSFERRING…");
        });
        break;
      }
      case "perms-open": {
        const entry = state.serverAuthority.guilds.roster.find((row) => row.actorId === id);
        openPermsFor = openPermsFor === id ? null : id;
        permsDraft = new Set(entry?.permissions ?? []);
        renderKey = ""; // force list repaint
        deps.sfx?.play("ui_button_tick");
        break;
      }
      case "perm-toggle": {
        const permission = button.dataset.perm as ServerAuthorityGuildPermission;
        if (permsDraft.has(permission)) permsDraft.delete(permission);
        else permsDraft.add(permission);
        button.setAttribute("aria-pressed", permsDraft.has(permission) ? "true" : "false");
        button.toggleAttribute("data-on", permsDraft.has(permission));
        break;
      }
      case "perms-apply": {
        const mask = guildPermissionsToMask([...permsDraft]);
        enqueueAuthorityGuildSetPermissionsCommand(state.authorityCommands, id, mask, tick);
        openPermsFor = null;
        renderKey = "";
        deps.sfx?.play("ui_button_tick");
        break;
      }
      case "war-declare": {
        const name = button.dataset.name ?? id;
        armConfirm("war", `DECLARE WAR ON ${name.toUpperCase()} — MUTUAL WHEN ACCEPTED`, () => {
          enqueueAuthorityGuildDeclareWarCommand(state.authorityCommands, id, issuedTick());
          flashStatus("DECLARING…");
        });
        break;
      }
      case "war-accept":
        enqueueAuthorityGuildAcceptWarCommand(state.authorityCommands, id, tick);
        deps.sfx?.play("ui_button_tick");
        break;
      case "war-rescind":
        enqueueAuthorityGuildRescindWarCommand(state.authorityCommands, id, tick);
        deps.sfx?.play("ui_button_tick");
        break;
      default:
        break;
    }
  });

  // ── Render ───────────────────────────────────────────────────────────────
  /** Rebuild a list container, restoring focus to the same data-fkey control. */
  const paintList = (container: HTMLElement, html: string): void => {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && container.contains(active) ? active.dataset.fkey ?? null : null;
    container.innerHTML = html;
    if (focusKey) container.querySelector<HTMLElement>(`[data-fkey="${focusKey}"]`)?.focus();
  };

  const lastSeenCopy = (lastSeenTick: number): string => {
    const seconds = Math.max(0, Math.round((issuedTick() - lastSeenTick) / Math.max(1, slice.tickRateHz)));
    if (seconds < 60) return "LAST SEEN JUST NOW";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `LAST SEEN ${minutes}M AGO`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `LAST SEEN ${hours}H ${minutes % 60}M AGO`;
    return `LAST SEEN ${Math.floor(hours / 24)}D AGO`;
  };

  const areaCopy = (areaId: string | null): string =>
    (areaId ?? "").replaceAll("-", " ").trim().toUpperCase() || "UNKNOWN AREA";

  const rosterRow = (entry: ServerAuthorityGuildRosterEntryState): string => {
    const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const self = entry.actorId === meId;
    const leaderRow = entry.role === "leader";
    const canManageRow = !self && !leaderRow;
    const canKick = canManageRow && hasGuildPermission(state, "kick");
    const canRoles = canManageRow && hasGuildPermission(state, "roles");
    const canTransfer = !self && isGuildLeader(state);
    const presence = entry.online
      ? `<span class="scp-pa-area">ONLINE · ${escapeHtml(areaCopy(entry.areaId))}</span>`
      : `<span class="scp-pa-lastseen">${lastSeenCopy(entry.lastSeenTick)}</span>`;
    const nextRole = entry.role === "officer" ? "member" : "officer";
    const actions = [
      canRoles ? `<button type="button" class="scp-pa-mini" data-act="role" data-role="${nextRole}" data-id="${escapeHtml(entry.actorId)}" data-fkey="role:${escapeHtml(entry.actorId)}" title="Set role to ${nextRole}">${nextRole === "officer" ? "PROMOTE" : "DEMOTE"}</button>` : "",
      canRoles ? `<button type="button" class="scp-pa-mini" data-act="perms-open" data-id="${escapeHtml(entry.actorId)}" data-fkey="perms:${escapeHtml(entry.actorId)}" aria-expanded="${openPermsFor === entry.actorId}" title="Edit permissions">PERMS</button>` : "",
      canTransfer ? `<button type="button" class="scp-pa-mini" data-act="transfer" data-id="${escapeHtml(entry.actorId)}" data-name="${escapeHtml(entry.name)}" data-fkey="xfer:${escapeHtml(entry.actorId)}" title="Transfer leadership">XFER</button>` : "",
      canKick ? `<button type="button" class="scp-pa-mini scp-pa-danger" data-act="kick" data-id="${escapeHtml(entry.actorId)}" data-fkey="kick:${escapeHtml(entry.actorId)}" title="Remove from the association">KICK</button>` : "",
    ].filter(Boolean).join("");
    const permsEditor = openPermsFor === entry.actorId && canRoles
      ? `<div class="scp-pa-permrow" role="group" aria-label="Permissions for ${escapeHtml(entry.name)}">
          ${GUILD_PERMISSIONS.map((permission) => `<button type="button" class="scp-pa-chip" data-act="perm-toggle" data-perm="${permission}" data-fkey="chip:${escapeHtml(entry.actorId)}:${permission}" aria-pressed="${permsDraft.has(permission)}"${permsDraft.has(permission) ? " data-on" : ""}>${permission.toUpperCase()}</button>`).join("")}
          <button type="button" class="scp-pa-mini" data-act="perms-apply" data-id="${escapeHtml(entry.actorId)}" data-fkey="apply:${escapeHtml(entry.actorId)}">APPLY</button>
        </div>`
      : "";
    return `<div class="scp-pa-row" role="listitem"${entry.online ? " data-online" : ""}>
        <span class="scp-pa-dot" aria-hidden="true"></span>
        <span class="scp-pa-name">${escapeHtml(entry.name)}${self ? '<span class="scp-pa-you"> · YOU</span>' : ""}</span>
        <span class="scp-pa-role" data-role="${entry.role}">${entry.role.toUpperCase()}</span>
        ${presence}
        <span class="scp-pa-actions">${actions}</span>
      </div>${permsEditor}`;
  };

  /** One live link truth for header + charter desk — never gated on renderKey. */
  const paintLinkState = (isLinked: boolean, funds: number): void => {
    refs.link.textContent = isLinked ? "TERMINAL LINKED" : "NO TERMINAL LINK";
    refs.link.toggleAttribute("data-denied", !isLinked);
    // Charter desk copy stays in lockstep even while the section is hidden
    // (in-guild), so leaving a guild never resurfaces a stale readiness line.
    refs.termRow.textContent = isLinked
      ? "TERMINAL LINKED · CHARTER DESK READY"
      : `AT PA TERMINAL ONLY · ≤${PA_REACH_CELLS} CELLS`;
    refs.termRow.toggleAttribute("data-denied", !isLinked);
    const affordable = funds >= GUILD_CHARTER_FEE_CREDITS;
    refs.found.disabled = !isLinked || !affordable;
    refs.found.title = !isLinked
      ? "Stand at a Player Association terminal to file a charter"
      : affordable
        ? ""
        : `Costs ${GUILD_CHARTER_FEE_CREDITS.toLocaleString()} credits (vault + wallet)`;
  };
  const update = (): void => {
    const nowMs = performance.now();

    // Terminal link (charter gate only; the window works everywhere).
    let terminalId = activePaTerminal();
    if (!terminalId || !withinPaTerminalRange(state, slice, terminalId)) {
      const nearby = nearestPaTerminalInRange(state, slice);
      if (nearby && nearby !== terminalId) {
        setActivePaTerminal(nearby);
        terminalId = nearby;
      }
    }
    linked = terminalId !== null && withinPaTerminalRange(state, slice, terminalId);
    linkedTerminalId = linked ? terminalId : null;
    const denied = rejectWatcher.poll();
    if (denied) flashStatus(denied, true);
    const view = state.serverAuthority.guilds;
    const guild = view.guild ?? null;
    const me = localGuildRosterEntry(state);
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const wallet = Math.max(0, Math.trunc(state.serverAuthority.actors[actorId]?.credits ?? 0));
    const vault = Math.max(0, Math.trunc(state.serverAuthority.bank?.credits ?? 0));
    const funds = wallet + vault;
    // Always drive both visible link strings (and charter gate) from one truth.
    paintLinkState(linked, funds);

    const nextKey = [
      guild ? `${guild.id}:${guild.memberCount}:${guild.leaderActorId}:${guild.wars.map((war) => `${war.opposingGuildId}=${war.state}`).join(",")}` : "none",
      view.roster.map((entry) => `${entry.actorId}:${entry.role}:${entry.permissions.join("+")}:${entry.online ? entry.areaId : entry.lastSeenTick}`).join("|"),
      view.pendingInvites.map((invite) => invite.inviteId).join("|"),
      view.directory.map((entry) => `${entry.id}:${entry.memberCount}`).join("|"),
      funds,
      openPermsFor ?? "-",
      me ? `${me.role}:${me.permissions.join("+")}` : "-",
    ].join("§");

    if (nextKey !== renderKey) {
      renderKey = nextKey;

      const inGuild = guild !== null;
      refs.summarySection.hidden = !inGuild;
      refs.rosterSection.hidden = !inGuild;
      refs.warSection.hidden = !inGuild;
      refs.memberActions.hidden = !inGuild;
      refs.charterSection.hidden = inGuild;
      refs.inviteSection.hidden = inGuild || view.pendingInvites.length === 0;

      if (inGuild) {
        refs.summary.innerHTML = `
          <span class="scp-pa-tag">&lt;${escapeHtml(guild.tag)}&gt;</span>
          <span class="scp-pa-guildname">${escapeHtml(guild.name)}</span>
          <span class="scp-pa-count">${guild.memberCount} MEMBER${guild.memberCount === 1 ? "" : "S"}</span>`;
        refs.rosterCount.textContent = `${view.roster.length}`;
        paintList(refs.rosterList, view.roster.map(rosterRow).join("")
          || '<div class="scp-pa-empty">ROSTER PENDING…</div>');

        const canWar = hasGuildPermission(state, "war");
        paintList(refs.warList, guild.wars.length === 0
          ? '<div class="scp-pa-empty">NO ACTIVE WARS</div>'
          : guild.wars.map((war) => {
            const actions = war.state === "incoming"
              ? (canWar ? `<button type="button" class="scp-pa-mini scp-pa-danger" data-act="war-accept" data-id="${escapeHtml(war.opposingGuildId)}" data-fkey="waracc:${escapeHtml(war.opposingGuildId)}" title="Accept — the war becomes mutual">ACCEPT</button>
                  <button type="button" class="scp-pa-mini" data-act="war-rescind" data-id="${escapeHtml(war.opposingGuildId)}" data-fkey="warref:${escapeHtml(war.opposingGuildId)}" title="Refuse the declaration">REFUSE</button>` : "")
              : (canWar ? `<button type="button" class="scp-pa-mini" data-act="war-rescind" data-id="${escapeHtml(war.opposingGuildId)}" data-fkey="warres:${escapeHtml(war.opposingGuildId)}" title="Stand down">RESCIND</button>` : "");
            return `<div class="scp-pa-row" role="listitem">
                <span class="scp-pa-tag">&lt;${escapeHtml(war.opposingTag)}&gt;</span>
                <span class="scp-pa-name">${escapeHtml(war.opposingName)}</span>
                <span class="scp-pa-war" data-stance="${war.state}">${war.state.toUpperCase()}</span>
                <span class="scp-pa-actions">${actions}</span>
              </div>`;
          }).join(""));

        refs.disband.hidden = !isGuildLeader(state);
      } else {
        refs.funds.textContent = `${funds.toLocaleString()} CR`;
        refs.funds.toggleAttribute("data-denied", funds < GUILD_CHARTER_FEE_CREDITS);

        paintList(refs.inviteList, view.pendingInvites.map((invite) => `
          <div class="scp-pa-row" role="listitem">
            <span class="scp-pa-tag">&lt;${escapeHtml(invite.guildTag)}&gt;</span>
            <span class="scp-pa-name">${escapeHtml(invite.guildName)}</span>
            <span class="scp-pa-from">FROM ${escapeHtml(invite.inviterName.toUpperCase())}</span>
            <span class="scp-pa-actions">
              <button type="button" class="scp-pa-mini" data-act="invite-accept" data-id="${escapeHtml(invite.inviteId)}" data-fkey="acc:${escapeHtml(invite.inviteId)}">ACCEPT</button>
              <button type="button" class="scp-pa-mini" data-act="invite-decline" data-id="${escapeHtml(invite.inviteId)}" data-fkey="dec:${escapeHtml(invite.inviteId)}">DECLINE</button>
            </span>
          </div>`).join(""));
      }

      const canDeclare = guild !== null && hasGuildPermission(state, "war");
      const atWarWith = new Set((guild?.wars ?? []).map((war) => war.opposingGuildId));
      paintList(refs.directoryList, view.directory.length === 0
        ? '<div class="scp-pa-empty">NO REGISTERED ASSOCIATIONS</div>'
        : view.directory.map((entry) => {
          const own = guild !== null && entry.id === guild.id;
          const warButton = canDeclare && !own && !atWarWith.has(entry.id)
            ? `<button type="button" class="scp-pa-mini scp-pa-danger" data-act="war-declare" data-id="${escapeHtml(entry.id)}" data-name="${escapeHtml(entry.name)}" data-fkey="dec-war:${escapeHtml(entry.id)}" title="Declare war">WAR</button>`
            : "";
          return `<div class="scp-pa-row" role="listitem"${own ? " data-own" : ""}>
              <span class="scp-pa-tag">&lt;${escapeHtml(entry.tag)}&gt;</span>
              <span class="scp-pa-name">${escapeHtml(entry.name)}${own ? '<span class="scp-pa-you"> · YOURS</span>' : ""}</span>
              <span class="scp-pa-count">${entry.memberCount} MEMBER${entry.memberCount === 1 ? "" : "S"}</span>
              <span class="scp-pa-actions">${warButton}</span>
            </div>`;
        }).join(""));
    }

    if (nowMs > statusFlashUntil && statusFlashUntil !== 0) {
      const statusEl = mustRef(root, "status");
      statusEl.textContent = "";
      statusEl.toggleAttribute("data-denied", false);
      statusFlashUntil = 0;
    }
  };

  update();

  return {
    update,
    onResized: () => {
      // Single scroll column; nothing to re-measure.
    },
    dispose: () => {
      root.removeEventListener("keydown", onRootKeyDown);
      contentRoot.innerHTML = "";
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mustRef(root: HTMLElement, ref: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${ref}"]`);
  if (!el) throw new Error(`pa window ref missing: ${ref}`);
  return el;
}
