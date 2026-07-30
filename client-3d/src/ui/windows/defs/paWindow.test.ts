// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlayState,
  type PlayState,
  type ServerAuthorityActorState,
  type ServerAuthorityGuildViewState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import { createWindowManager, type WindowManager } from "../windowManager";
import {
  createPaWindowDefinition,
  PA_WINDOW_ID,
  setActivePaTerminal,
} from "./paWindow";

function fixtureSlice(terminalCell = { x: 10, y: 10 }): SliceSnapshot {
  return {
    schema: "fixture",
    tick: 200,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "PA Test", width: 48, height: 48, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "PA Test", kind: "overworld", width: 48, height: 48, level: 0 }],
    stateHash: "pa-window-test",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "open-desert-overworld",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: { x: 10, y: 10 },
      route: [],
    }],
    props: [{
      id: "dustgate-pa-terminal",
      entity: "prop:open-desert-overworld:dustgate-pa-terminal",
      areaId: "open-desert-overworld",
      label: "PA Terminal",
      kind: "pa_terminal",
      cell: terminalCell,
      size: { w: 1, h: 1 },
      interactive: true,
      solid: false,
    }],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  } as unknown as SliceSnapshot;
}

function memberView(overrides: Partial<ServerAuthorityGuildViewState> = {}): ServerAuthorityGuildViewState {
  return {
    guild: {
      id: "guild_dune",
      name: "Dune Cooperative",
      tag: "DUNE",
      leaderActorId: "player",
      createdTick: 10,
      memberCount: 3,
      wars: [
        { opposingGuildId: "guild_rust", opposingName: "Rust Pact", opposingTag: "RUST", state: "incoming", declaredTick: 60 },
        { opposingGuildId: "guild_glass", opposingName: "Glass Union", opposingTag: "GLS", state: "outgoing", declaredTick: 80 },
      ],
    },
    roster: [
      { actorId: "player", name: "Field Observer", role: "leader", permissions: [], online: true, areaId: "open-desert-overworld", lastSeenTick: 200 },
      { actorId: "vendor", name: "Warden", role: "officer", permissions: ["invite", "kick"], online: true, areaId: "lowbough-station", lastSeenTick: 200 },
      { actorId: "drifter", name: "Dust Drifter", role: "member", permissions: [], online: false, areaId: null, lastSeenTick: 20 },
    ],
    pendingInvites: [],
    directory: [
      { id: "guild_dune", name: "Dune Cooperative", tag: "DUNE", memberCount: 3 },
      { id: "guild_rust", name: "Rust Pact", tag: "RUST", memberCount: 9 },
      { id: "guild_free", name: "Freeholders", tag: "FREE", memberCount: 4 },
    ],
    ...overrides,
  };
}

interface Harness {
  manager: WindowManager;
  state: PlayState;
  root: HTMLElement;
  chat: { sendGuildLine: ReturnType<typeof vi.fn>; selectGuildChannel: ReturnType<typeof vi.fn> };
}

function mountPa(patch: {
  guilds?: ServerAuthorityGuildViewState;
  walletCredits?: number;
  terminalCell?: { x: number; y: number };
  meActorId?: string;
} = {}): Harness {
  const slice = fixtureSlice(patch.terminalCell);
  const state = createPlayState(slice);
  const meActorId = patch.meActorId ?? "player";
  state.playerActorId = "player";
  state.serverAuthority.playerActorId = meActorId;
  state.serverAuthority.snapshotTick = slice.tick;
  state.serverAuthority.lastSnapshotReceivedAtMs = state.worldTimeMs;
  state.serverAuthority.actors[meActorId] = {
    id: meActorId,
    label: "Field Observer",
    role: "player",
    areaId: "open-desert-overworld",
    x: 10,
    y: 10,
    lifeState: "alive",
    credits: patch.walletCredits ?? 300_000,
  } as unknown as ServerAuthorityActorState;
  if (patch.guilds) state.serverAuthority.guilds = patch.guilds;
  const chat = { sendGuildLine: vi.fn(() => true), selectGuildChannel: vi.fn(() => true) };
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const manager = createWindowManager({
    mount,
    state,
    slice,
    storageScope: `pa-test-${Math.random()}`,
  });
  manager.register(createPaWindowDefinition({ chat }));
  manager.open(PA_WINDOW_ID);
  manager.update(0, 0);
  return { manager, state, root: manager.root, chat };
}

function text(root: HTMLElement, selector: string): string {
  return root.querySelector<HTMLElement>(selector)?.textContent?.trim() ?? "";
}

function click(root: HTMLElement, selector: string): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function lastCommand(state: PlayState): unknown {
  return state.authorityCommands.pending.at(-1)?.command ?? null;
}

afterEach(() => {
  setActivePaTerminal(null);
  document.body.textContent = "";
  localStorage.clear();
});

describe("pa window — charter (no guild)", () => {
  it("shows the exact 250,000 fee and requires terminal range", () => {
    const { root, manager } = mountPa({ terminalCell: { x: 40, y: 40 } });
    expect(text(root, '[data-ref="fee"]')).toBe("250,000 CR");
    expect(text(root, '[data-ref="link"]')).toBe("NO TERMINAL LINK");
    const found = root.querySelector<HTMLButtonElement>('[data-ref="found"]')!;
    expect(found.disabled).toBe(true);
    expect(found.title).toContain("terminal");
    expect(root.querySelector<HTMLElement>('[data-ref="termRow"]')?.hasAttribute("data-denied")).toBe(true);
    manager.dispose();
  });

  it("disables FOUND on insufficient funds even at the terminal", () => {
    const { root, manager } = mountPa({ walletCredits: 249_999 });
    expect(text(root, '[data-ref="link"]')).toBe("TERMINAL LINKED");
    const found = root.querySelector<HTMLButtonElement>('[data-ref="found"]')!;
    expect(found.disabled).toBe(true);
    expect(found.title).toContain("250,000");
    manager.dispose();
  });

  it("files GuildCreate with name, uppercased tag and the linked terminal prop id", () => {
    const { root, state, manager } = mountPa({ walletCredits: 250_000 });
    const name = root.querySelector<HTMLInputElement>('[data-ref="charterName"]')!;
    const tag = root.querySelector<HTMLInputElement>('[data-ref="charterTag"]')!;
    name.value = "Dune Cooperative";
    tag.value = "dune";
    tag.dispatchEvent(new Event("input", { bubbles: true }));
    expect(tag.value).toBe("DUNE");
    const found = root.querySelector<HTMLButtonElement>('[data-ref="found"]')!;
    expect(found.disabled).toBe(false);
    click(root, '[data-ref="found"]');
    expect(lastCommand(state)).toEqual({
      GuildCreate: { name: "Dune Cooperative", tag: "DUNE", terminal_prop_id: "dustgate-pa-terminal" },
    });
    manager.dispose();
  });

  it("lists invites and enqueues accept/decline with the exact invite_id", () => {
    const { root, state, manager } = mountPa({
      guilds: {
        roster: [],
        pendingInvites: [{
          inviteId: "inv_9",
          guildId: "guild_rust",
          guildName: "Rust Pact",
          guildTag: "RUST",
          inviterActorId: "vendor",
          inviterName: "Warden",
          issuedTick: 100,
          expiresTick: 999,
        }],
        directory: [],
      },
    });
    expect(text(root, '[data-ref="inviteList"]')).toContain("Rust Pact");
    expect(text(root, '[data-ref="inviteList"]')).toContain("FROM WARDEN");
    click(root, '[data-act="invite-accept"]');
    expect(lastCommand(state)).toEqual({ GuildAcceptInvite: { invite_id: "inv_9" } });
    click(root, '[data-act="invite-decline"]');
    expect(lastCommand(state)).toEqual({ GuildDeclineInvite: { invite_id: "inv_9" } });
    manager.dispose();
  });
});

describe("pa window — roster wording and permission gating", () => {
  it("shows area only for online members and last-seen age for offline members", () => {
    const { root, manager } = mountPa({ guilds: memberView() });
    const rows = [...root.querySelectorAll<HTMLElement>('[data-ref="rosterList"] .scp-pa-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.hasAttribute("data-online")).toBe(true);
    expect(rows[0]?.textContent).toContain("ONLINE · OPEN DESERT OVERWORLD");
    expect(rows[1]?.textContent).toContain("ONLINE · LOWBOUGH STATION");
    expect(rows[2]?.hasAttribute("data-online")).toBe(false);
    // Fixture last-seen is seconds old — the freshest offline wording.
    expect(rows[2]?.textContent).toContain("LAST SEEN JUST NOW");
    expect(rows[2]?.textContent).not.toContain("ONLINE");
    manager.dispose();
    document.body.textContent = "";

    // An hour-old last-seen tick reads as an age, never as an area.
    const view = memberView();
    view.roster[2] = { ...view.roster[2]!, lastSeenTick: 200 - 3600 * 30 };
    const aged = mountPa({ guilds: view });
    const agedRow = [...aged.root.querySelectorAll<HTMLElement>('[data-ref="rosterList"] .scp-pa-row')][2];
    expect(agedRow?.textContent).toMatch(/LAST SEEN \d+H \d+M AGO/u);
    aged.manager.dispose();
  });

  it("shows management controls to the leader and none to an unprivileged member", () => {
    const leader = mountPa({ guilds: memberView() });
    const rosterHtml = leader.root.querySelector('[data-ref="rosterList"]')!.innerHTML;
    expect(rosterHtml).toContain('data-act="kick"');
    expect(rosterHtml).toContain('data-act="transfer"');
    expect(rosterHtml).toContain('data-act="perms-open"');
    expect(leader.root.querySelector<HTMLButtonElement>('[data-ref="disband"]')!.hidden).toBe(false);
    leader.manager.dispose();
    document.body.textContent = "";

    const member = mountPa({ guilds: memberView(), meActorId: "drifter" });
    const memberHtml = member.root.querySelector('[data-ref="rosterList"]')!.innerHTML;
    expect(memberHtml).not.toContain('data-act="kick"');
    expect(memberHtml).not.toContain('data-act="transfer"');
    expect(memberHtml).not.toContain('data-act="perms-open"');
    expect(member.root.querySelector<HTMLButtonElement>('[data-ref="disband"]')!.hidden).toBe(true);
    // No war permission either: no ACCEPT / RESCIND / declare controls.
    expect(member.root.querySelector('[data-act="war-accept"]')).toBeNull();
    expect(member.root.querySelector('[data-act="war-declare"]')).toBeNull();
    member.manager.dispose();
  });

  it("kicks, promotes and applies the frozen permission mask", () => {
    const { root, state, manager } = mountPa({ guilds: memberView() });
    click(root, '[data-fkey="kick:drifter"]');
    expect(lastCommand(state)).toEqual({ GuildKick: { target_actor_id: "drifter" } });
    click(root, '[data-fkey="role:drifter"]');
    expect(lastCommand(state)).toEqual({ GuildSetRole: { target_actor_id: "drifter", role: "officer" } });

    // Open the permission editor for the officer (invite+kick = 1|2), grant WAR.
    click(root, '[data-fkey="perms:vendor"]');
    manager.update(0, 0);
    click(root, '[data-fkey="chip:vendor:war"]');
    click(root, '[data-fkey="apply:vendor"]');
    expect(lastCommand(state)).toEqual({ GuildSetPermissions: { target_actor_id: "vendor", permissions: 1 | 2 | 8 } });
    manager.dispose();
  });
});

describe("pa window — wars and directory", () => {
  it("accepts an incoming war and rescinds an outgoing one with exact payloads", () => {
    const { root, state, manager } = mountPa({ guilds: memberView() });
    const warList = root.querySelector('[data-ref="warList"]')!;
    expect(warList.textContent).toContain("INCOMING");
    expect(warList.textContent).toContain("OUTGOING");
    click(root, '[data-fkey="waracc:guild_rust"]');
    expect(lastCommand(state)).toEqual({ GuildAcceptWar: { opposing_guild_id: "guild_rust" } });
    click(root, '[data-fkey="warres:guild_glass"]');
    expect(lastCommand(state)).toEqual({ GuildRescindWar: { opposing_guild_id: "guild_glass" } });
    manager.dispose();
  });

  it("declares war from the directory behind a confirm, skipping own guild and active wars", () => {
    const { root, state, manager } = mountPa({ guilds: memberView() });
    // Own guild row and already-at-war row carry no WAR button.
    expect(root.querySelector('[data-fkey="dec-war:guild_dune"]')).toBeNull();
    expect(root.querySelector('[data-fkey="dec-war:guild_rust"]')).toBeNull();
    click(root, '[data-fkey="dec-war:guild_free"]');
    // Armed, not fired.
    expect(lastCommand(state)).toBeNull();
    expect(root.querySelector<HTMLElement>('[data-ref="confirmBar"]')!.hidden).toBe(false);
    expect(text(root, '[data-ref="confirmLabel"]')).toContain("FREEHOLDERS");
    click(root, '[data-ref="confirmYes"]');
    expect(lastCommand(state)).toEqual({ GuildDeclareWar: { opposing_guild_id: "guild_free" } });
    manager.dispose();
  });

  it("renders the public directory for outsiders with no roster or presence data", () => {
    const { root, manager } = mountPa({
      guilds: {
        roster: [],
        pendingInvites: [],
        directory: [{ id: "guild_rust", name: "Rust Pact", tag: "RUST", memberCount: 9 }],
      },
    });
    expect(text(root, '[data-ref="directoryList"]')).toContain("Rust Pact");
    expect(text(root, '[data-ref="directoryList"]')).toContain("9 MEMBERS");
    expect(root.querySelector('[data-ref="rosterSection"]')!.hasAttribute("hidden")).toBe(true);
    expect(root.querySelector('[data-act="war-declare"]')).toBeNull();
    manager.dispose();
  });
});

describe("pa window — confirm, escape and reject feedback", () => {
  it("confirms leave/disband/transfer and lets Escape cancel the armed confirm", () => {
    const { root, state, manager } = mountPa({ guilds: memberView() });

    click(root, '[data-ref="leave"]');
    const confirmBar = root.querySelector<HTMLElement>('[data-ref="confirmBar"]')!;
    expect(confirmBar.hidden).toBe(false);
    expect(lastCommand(state)).toBeNull();
    // Escape cancels the confirm instead of firing or closing.
    root.querySelector<HTMLElement>('[data-ref="confirmYes"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }));
    expect(confirmBar.hidden).toBe(true);
    expect(lastCommand(state)).toBeNull();
    expect(manager.isOpen(PA_WINDOW_ID)).toBe(true);

    click(root, '[data-ref="leave"]');
    click(root, '[data-ref="confirmYes"]');
    expect(lastCommand(state)).toEqual({ GuildLeave: {} });

    click(root, '[data-ref="disband"]');
    expect(text(root, '[data-ref="confirmLabel"]')).toContain("CANNOT BE UNDONE");
    click(root, '[data-ref="confirmYes"]');
    expect(lastCommand(state)).toEqual({ GuildDisband: {} });

    click(root, '[data-fkey="xfer:vendor"]');
    expect(text(root, '[data-ref="confirmLabel"]')).toContain("WARDEN");
    click(root, '[data-ref="confirmYes"]');
    expect(lastCommand(state)).toEqual({ GuildTransferLeadership: { target_actor_id: "vendor" } });
    manager.dispose();
  });

  it("flashes the exact reject reason for watched guild commands", () => {
    const { root, state, manager } = mountPa({});
    state.serverAuthority.sentCommandLog.push({ commandId: 7, kind: "GuildCreate", sentAtMs: 0 });
    state.serverAuthority.lastReceipt = {
      commandId: 7,
      accepted: false,
      tick: 210,
      reasonCode: "insufficient_credits",
      receivedAtMs: 0,
    };
    manager.update(0, 0);
    expect(text(root, '[data-ref="status"]')).toBe("DENIED · INSUFFICIENT CREDITS");
    manager.dispose();
  });
});

describe("pa window — guild chat entry", () => {
  it("sends a guild line through the chat bridge and clears the field", () => {
    const { root, chat, manager } = mountPa({ guilds: memberView() });
    const input = root.querySelector<HTMLInputElement>('[data-ref="chatInput"]')!;
    input.value = "rally at the dustgate";
    click(root, '[data-ref="chatSend"]');
    expect(chat.sendGuildLine).toHaveBeenCalledWith("rally at the dustgate");
    expect(input.value).toBe("");

    input.value = "second line";
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", bubbles: true, cancelable: true }));
    expect(chat.sendGuildLine).toHaveBeenCalledWith("second line");
    manager.dispose();
  });

  it("selects the GUILD channel on the HUD pane from the CHANNEL control", () => {
    const { root, chat, manager } = mountPa({ guilds: memberView() });
    click(root, '[data-ref="chatChannel"]');
    expect(chat.selectGuildChannel).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
});

describe("pa window — terminal link lockstep", () => {
  const linkCopy = (root: HTMLElement) => text(root, '[data-ref="link"]');
  const termCopy = (root: HTMLElement) => text(root, '[data-ref="termRow"]');
  const movePlayer = (state: PlayState, x: number, y: number): void => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const actor = state.serverAuthority.actors[actorId];
    if (!actor) throw new Error("missing player actor");
    actor.x = x;
    actor.y = y;
    state.player.x = x;
    state.player.y = y;
  };

  it("keeps header and charter-desk link copy on one truth while walking in and out of range", () => {
    // Screenshot contradiction: header "NO TERMINAL LINK" while charter desk
    // still reads "TERMINAL LINKED · CHARTER DESK READY" (or the reverse).
    const { root, state, manager } = mountPa({ terminalCell: { x: 10, y: 10 } });
    expect(linkCopy(root)).toBe("TERMINAL LINKED");
    expect(termCopy(root)).toBe("TERMINAL LINKED · CHARTER DESK READY");
    expect(root.querySelector('[data-ref="link"]')!.hasAttribute("data-denied")).toBe(false);
    expect(root.querySelector('[data-ref="termRow"]')!.hasAttribute("data-denied")).toBe(false);

    movePlayer(state, 40, 40);
    manager.update(0, 0);
    expect(linkCopy(root)).toBe("NO TERMINAL LINK");
    expect(termCopy(root)).toBe("AT PA TERMINAL ONLY · ≤1.75 CELLS");
    expect(root.querySelector('[data-ref="link"]')!.hasAttribute("data-denied")).toBe(true);
    expect(root.querySelector('[data-ref="termRow"]')!.hasAttribute("data-denied")).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-ref="found"]')!.disabled).toBe(true);

    movePlayer(state, 10, 10);
    manager.update(0, 0);
    expect(linkCopy(root)).toBe("TERMINAL LINKED");
    expect(termCopy(root)).toBe("TERMINAL LINKED · CHARTER DESK READY");
    expect(root.querySelector('[data-ref="link"]')!.hasAttribute("data-denied")).toBe(false);
    expect(root.querySelector('[data-ref="termRow"]')!.hasAttribute("data-denied")).toBe(false);
    manager.dispose();
  });

  it("keeps the same single link truth on the in-guild branch while range flips", () => {
    const { root, state, manager } = mountPa({ guilds: memberView() });
    expect(root.querySelector('[data-ref="charterSection"]')!.hasAttribute("hidden")).toBe(true);
    expect(linkCopy(root)).toBe("TERMINAL LINKED");
    // Hidden charter desk still tracks live link so a later leave cannot resurrect stale readiness.
    expect(termCopy(root)).toBe("TERMINAL LINKED · CHARTER DESK READY");

    movePlayer(state, 40, 40);
    manager.update(0, 0);
    expect(linkCopy(root)).toBe("NO TERMINAL LINK");
    expect(termCopy(root)).toBe("AT PA TERMINAL ONLY · ≤1.75 CELLS");
    expect(root.querySelector('[data-ref="link"]')!.hasAttribute("data-denied")).toBe(true);
    expect(root.querySelector('[data-ref="termRow"]')!.hasAttribute("data-denied")).toBe(true);

    movePlayer(state, 10.5, 10.2);
    manager.update(0, 0);
    expect(linkCopy(root)).toBe("TERMINAL LINKED");
    expect(termCopy(root)).toBe("TERMINAL LINKED · CHARTER DESK READY");
    manager.dispose();
  });
});

describe("pa window — motion and focus styles", () => {
  it("ships reduced-motion and focus-visible treatments for the PA controls", () => {
    const css = readFileSync("src/ui/windows/windows.css", "utf8");
    const paSection = css.slice(css.indexOf("ASSOCIATION — Player Association"));
    expect(paSection).toContain("@media (prefers-reduced-motion: reduce)");
    expect(paSection).toContain(".scp-pa-primary {\n    transition: none;");
    expect(paSection).toContain(":focus-visible");
  });
});
