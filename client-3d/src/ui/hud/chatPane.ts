import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { getLaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import {
  chatWsUrl,
  createChatClient,
  type ChatChannel,
  type ChatClient,
  type ChatMessage,
  type ChatSendChannel,
} from "@successor/client/src/chat/chatClient";
import { enqueueSpatialBubble } from "@successor/client/src/slice-core/spatialBubbleSystem";
import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { isGuildMember } from "@successor/client/src/slice-core/guildSystem";
import type { SlashCommandRouter } from "./slashCommands";
import { renderFriendsList } from "./friendsList";
import type { CombatLogFeed, CombatLogLine } from "./combatLog";

/**
 * Chat pane — bottom-left HUD on the extracted DOM-free chat transport
 * (`client/src/chat/chatClient.ts`; own WebSocket, separate from the game
 * authority, with reconnect + channels + /commands).
 * Gameplay slash commands (waypoints, survey/sample, posture, clone, camp)
 * intercept BEFORE submitLine via the injected SlashCommandRouter (local
 * SYSTEM echo, no chat traffic); unknown /commands fall through untouched.
 *
 * TABS: ALL = the classic fading log; GLOBAL = shard-wide player chat;
 * COMBAT = the detailed local
 * combat feed (ui/hud/combatLog.ts — swings in/out, damage + zones, kills,
 * deaths, XP grants, rejected attacks). The COMBAT surface is a real
 * scrollback column (thin scrollbar, 200-line ring, sticky bottom) with an
 * optional [TS] wall-clock stamp; an unread pip marks the COMBAT tab while
 * ALL is active. The feed drains on this pane's own rAF loop — the same
 * self-driving pattern as the radar/queue panes.
 * FRIENDS = the presence roster off ChatClientState.friends (directed list;
 * ui/hud/friendsList.ts) — repainted only when the friends array reference
 * changes on a server packet.
 *
 * View: a glass pane with the last few messages fading upward, a channel tint
 * bar per row, and an input row. Enter (outside any text input) focuses the
 * chat input, Esc blurs it. While typing, the shared isTextInputTarget gate
 * already suppresses game keys and window hotkeys.
 *
 * LOCAL messages also dispatch spatial bubbles over the sender's pawn via the
 * shared bubble system (actor id == player identity id in this runtime family;
 * unknown senders simply skip the bubble). Wider/private channels stay in the
 * pane and never masquerade as nearby speech.
 */
export interface ChatPaneController {
  dispose: () => void;
  /** PA-window bridge: submit one line to the GUILD channel (membership-gated). */
  sendGuildLine: (body: string) => boolean;
  /** PA-window bridge: switch the send channel to GUILD and focus the input. */
  selectGuildChannel: () => boolean;
}

declare global {
  interface Window {
    /** Verification bridge: live chat transport counters. */
    __successor3dChatProbe?: { messageCount: number; connected: boolean; friendCount: number };
  }
}

const VISIBLE_ROWS = 6;
const COMBAT_RING_MAX = 200;
const SEND_CHANNELS: readonly ChatSendChannel[] = ["local", "zone", "global", "trade", "party", "guild"];
const CHAT_TAB_STORAGE_KEY = "successor3d.chat.tab.v1";
const COMBAT_TS_STORAGE_KEY = "successor3d.chat.combat-ts.v1";

const COMBAT_TONE_TINT: Record<string, string> = {
  "out-good": "var(--sc3d-accent)",
  "out-bad": "var(--sc3d-ink-dim)",
  "in-bad": "var(--sc3d-danger)",
  kill: "var(--sc3d-accent)",
  death: "var(--sc3d-danger)",
  xp: "var(--sc-fixed-ochre)",
  reject: "var(--sc3d-danger)",
  info: "var(--sc3d-hairline)",
};

const CHANNEL_TINT: Record<string, string> = {
  local: "var(--sc3d-ink-dim)",
  zone: "var(--sc3d-accent)",
  global: "var(--sc3d-accent-soft)",
  trade: "var(--sc-fixed-ochre)",
  party: "var(--sc-fixed-olive)",
  guild: "var(--sc-fixed-oxide)",
  whisper: "var(--sc3d-accent-soft)",
  system: "var(--sc3d-hairline)",
};

export function createChatPaneClient(
  state: PlayState,
  sfx: SfxPlayer,
  onLaunchFailure?: () => void,
): ChatClient {
  const identity = getLaunchIdentity();
  return createChatClient({
    self: {
      id: identity.playerId,
      displayName: identity.displayName,
      status: "online",
      since: new Date().toISOString(),
    },
    zoneId: identity.zoneId,
    authTicket: identity.standalone ? identity.chatTicket : undefined,
    authReleaseId: identity.standalone ? identity.clientReleaseId : undefined,
    onFailure: identity.standalone ? onLaunchFailure : undefined,
    // The bubble message passes through unchanged — no actorId; the shared
    // bubble system's fallback rule
    // anchors it to the local/followed pawn.
    onBubble: (message) => {
      enqueueSpatialBubble(state, message);
      sfx.play(message.own ? "chat_send" : "chat_receive");
    },
  });
}

export function mountChatPane(
  shell: HTMLElement,
  state: PlayState,
  sfx: SfxPlayer,
  slash?: SlashCommandRouter,
  combatFeed?: CombatLogFeed,
  onLaunchFailure?: () => void,
  chatClient?: ChatClient,
): ChatPaneController {
  const pane = document.createElement("aside");
  pane.className = "sc3d-chat";
  pane.innerHTML = `
    <nav class="sc3d-chat-tabs" data-ref="tabs" aria-label="Chat feeds">
      <button type="button" class="sc3d-chat-tab" data-tab="all" aria-selected="true">ALL</button>
      <button type="button" class="sc3d-chat-tab" data-tab="global" aria-selected="false">GLOBAL</button>
      <button type="button" class="sc3d-chat-tab" data-tab="combat" aria-selected="false">COMBAT<span class="sc3d-chat-unread" data-ref="unread" hidden></span></button>
      <button type="button" class="sc3d-chat-tab" data-tab="friends" aria-selected="false">FRIENDS</button>
      <button type="button" class="sc3d-chat-ts" data-ref="ts" title="Toggle timestamps" hidden>TS</button>
    </nav>
    <div class="sc3d-chat-log" data-ref="log" aria-live="polite"></div>
    <div class="sc3d-chat-log sc3d-chat-combatlog" data-ref="combatLog" hidden></div>
    <div class="sc3d-chat-log sc3d-chat-friends" data-ref="friends" hidden></div>
    <div class="sc3d-chat-inputrow" data-ref="inputRow">
      <button class="sc3d-chat-channel" type="button" data-ref="channel" title="Send channel">LOCAL</button>
      <input class="sc3d-chat-input" data-ref="input" type="text" maxlength="240"
        autocomplete="off" spellcheck="false" aria-label="Chat message" />
    </div>
  `;
  shell.appendChild(pane);

  const log = ref(pane, "log");
  const combatLogEl = ref(pane, "combatLog");
  const friendsEl = ref(pane, "friends");
  const tabsEl = ref(pane, "tabs");
  const unreadEl = ref(pane, "unread");
  const tsBtn = ref(pane, "ts") as HTMLButtonElement;
  const channelBtn = ref(pane, "channel") as HTMLButtonElement;
  const input = ref(pane, "input") as HTMLInputElement;

  const client = chatClient ?? createChatPaneClient(state, sfx, onLaunchFailure);

  const probe = { messageCount: 0, connected: client.state.connected, friendCount: client.state.friends.length };
  window.__successor3dChatProbe = probe;

  // ── Log rendering: last N rows, oldest at top (CSS fades them upward) ───
  const renderLog = (): void => {
    const messages = activeTab === "global"
      ? client.state.messages.filter((message) => message.channel === "global")
      : client.state.messages;
    const start = Math.max(0, messages.length - VISIBLE_ROWS);
    log.textContent = "";
    for (let i = start; i < messages.length; i += 1) {
      log.appendChild(rowFor(messages[i]!));
    }
  };
  const rowFor = (message: ChatMessage): HTMLElement => {
    const row = document.createElement("div");
    row.className = "sc3d-chat-row";
    row.style.setProperty("--chat-tint", CHANNEL_TINT[message.channel] ?? "var(--sc3d-ink-dim)");
    const sender = document.createElement("span");
    sender.className = "sc3d-chat-sender";
    sender.textContent = message.system ? message.channel.toUpperCase() : message.sender.displayName;
    const body = document.createElement("span");
    body.className = "sc3d-chat-body";
    body.textContent = message.body;
    row.append(sender, body);
    return row;
  };

  // FRIENDS roster: every friends mutation replaces the array (snapshot or
  // upsert), so a reference check is an exact repaint gate.
  let renderedFriends: unknown = null;
  const renderFriendsIfChanged = (): void => {
    probe.friendCount = client.state.friends.length;
    if (friendsEl.hidden || renderedFriends === client.state.friends) return;
    renderedFriends = client.state.friends;
    renderFriendsList(friendsEl, client.state.friends);
  };

  const unsubscribe = client.subscribe((event) => {
    if (event.type === "message-appended") {
      probe.messageCount += 1;
      renderLog();
    }
    probe.connected = client.state.connected;
    renderFriendsIfChanged();
  });

  // ── COMBAT tab: local feed scrollback (ring 200, sticky bottom) ─────────
  const storedTab = readStored(CHAT_TAB_STORAGE_KEY);
  let activeTab: "all" | "global" | "combat" | "friends" = (
    storedTab === "global" || storedTab === "combat" || storedTab === "friends"
  ) ? storedTab : "all";
  let showTimestamps = readStored(COMBAT_TS_STORAGE_KEY) === "1";
  let combatUnread = 0;
  let combatRows = 0;
  let feedFrameId = 0;

  const applyTab = (): void => {
    log.hidden = activeTab !== "all" && activeTab !== "global";
    combatLogEl.hidden = activeTab !== "combat";
    friendsEl.hidden = activeTab !== "friends";
    tsBtn.hidden = activeTab !== "combat";
    for (const button of tabsEl.querySelectorAll<HTMLButtonElement>(".sc3d-chat-tab")) {
      button.setAttribute("aria-selected", button.dataset.tab === activeTab ? "true" : "false");
    }
    if (activeTab === "combat") {
      combatUnread = 0;
      unreadEl.hidden = true;
      combatLogEl.scrollTop = combatLogEl.scrollHeight;
    }
    if (activeTab === "friends") renderFriendsIfChanged();
    if (activeTab === "all" || activeTab === "global") renderLog();
    writeStored(CHAT_TAB_STORAGE_KEY, activeTab);
  };

  const applyTsToggle = (): void => {
    tsBtn.toggleAttribute("data-on", showTimestamps);
    combatLogEl.toggleAttribute("data-ts", showTimestamps);
    writeStored(COMBAT_TS_STORAGE_KEY, showTimestamps ? "1" : "0");
  };

  tabsEl.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".sc3d-chat-tab") : null;
    const tab = button?.dataset.tab;
    if (tab === "all" || tab === "global" || tab === "combat" || tab === "friends") {
      activeTab = tab;
      applyTab();
    }
  });
  tsBtn.addEventListener("click", () => {
    showTimestamps = !showTimestamps;
    applyTsToggle();
  });

  const appendCombatLine = (line: CombatLogLine): void => {
    const row = document.createElement("div");
    row.className = "sc3d-chat-row sc3d-chat-combatrow";
    row.style.setProperty("--chat-tint", COMBAT_TONE_TINT[line.tone] ?? "var(--sc3d-ink-dim)");
    row.dataset.tone = line.tone;
    if (line.emphasis) row.toggleAttribute("data-emphasis", true);
    const stamp = document.createElement("span");
    stamp.className = "sc3d-chat-stamp";
    stamp.textContent = wallClockStamp();
    const body = document.createElement("span");
    body.className = "sc3d-chat-body";
    body.textContent = line.text;
    row.append(stamp, body);
    const atBottom = combatLogEl.scrollTop + combatLogEl.clientHeight >= combatLogEl.scrollHeight - 6;
    combatLogEl.appendChild(row);
    combatRows += 1;
    while (combatRows > COMBAT_RING_MAX && combatLogEl.firstChild) {
      combatLogEl.removeChild(combatLogEl.firstChild);
      combatRows -= 1;
    }
    if (activeTab === "combat") {
      if (atBottom) combatLogEl.scrollTop = combatLogEl.scrollHeight;
    } else {
      combatUnread += 1;
      unreadEl.textContent = combatUnread > 99 ? "99+" : String(combatUnread);
      unreadEl.hidden = false;
    }
  };

  // Self-driving drain (radar/queue pane pattern): cheap no-op when quiet.
  const feedFrame = (): void => {
    feedFrameId = requestAnimationFrame(feedFrame);
    // Membership loss snaps a gated send channel home (cheap diff-gated read).
    if (sendChannel !== "local" && !channelAvailable(sendChannel)) {
      sendChannel = "local";
      applyChannel();
    }
    if (!combatFeed) return;
    for (const line of combatFeed.drain()) appendCombatLine(line);
  };
  if (combatFeed) feedFrameId = requestAnimationFrame(feedFrame);
  applyTab();
  applyTsToggle();

  // ── Channel cycle (icon-first: one short-noun chip, click advances) ─────
  // PARTY/GUILD gate on live membership (P2.16): a send channel with no
  // system behind it is a fake affordance. The cycle skips gated channels;
  // losing membership snaps an active gated channel back to LOCAL.
  let sendChannel: ChatSendChannel = "local";
  const channelAvailable = (channel: ChatSendChannel): boolean => {
    if (channel === "party") return (state.serverAuthority.group.members?.length ?? 0) > 0;
    if (channel === "guild") return isGuildMember(state);
    return true;
  };
  const applyChannel = (): void => {
    channelBtn.textContent = sendChannel.toUpperCase();
    channelBtn.style.setProperty("--chat-tint", CHANNEL_TINT[sendChannel] ?? "var(--sc3d-ink-dim)");
    client.setActiveChannel(sendChannel as ChatChannel);
  };
  channelBtn.addEventListener("click", () => {
    const index = SEND_CHANNELS.indexOf(sendChannel);
    for (let step = 1; step <= SEND_CHANNELS.length; step += 1) {
      const candidate = SEND_CHANNELS[(index + step) % SEND_CHANNELS.length]!;
      if (channelAvailable(candidate)) {
        sendChannel = candidate;
        break;
      }
    }
    applyChannel();
  });
  applyChannel();

  // ── Input: Enter submits, Esc blurs; both stop short of the game/window ──
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code === "Enter" || event.code === "NumpadEnter") {
      // Chorded/owned Enter (desktop Alt+Enter fullscreen) never submits.
      if (event.defaultPrevented || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const value = input.value.trim();
      if (value) {
        const echo = slash?.handle(value) ?? null;
        if (echo !== null) {
          client.injectMessage({
            id: `slash_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            channel: "system",
            sender: { id: "client", displayName: "SYSTEM" },
            body: echo,
            system: true,
          });
        } else {
          client.submitLine(value);
        }
      }
      input.value = "";
      // Commit returns focus to the world: WASD must work immediately after
      // sending (the old Alt-tap machinery used to do this blur).
      input.blur();
      return;
    }
    if (event.code === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
    }
  });

  // Enter focuses the chat input — but never steals it from an interactive
  // control (inventory slots and buttons handle Enter themselves and the
  // keydown still bubbles to window).
  const onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
    // Never on owned/chorded Enter: the desktop shell preventDefault()s its
    // fullscreen chord (Alt+Enter) in a capture listener, which does NOT stop
    // propagation — without these guards that chord focused the chat input.
    if (event.defaultPrevented || event.altKey || event.repeat) return;
    const target = event.target;
    if (
      target instanceof Element
      && target.closest("button, input, textarea, select, [contenteditable], [role=\"gridcell\"]")
    ) return;
    event.preventDefault();
    input.focus();
  };
  window.addEventListener("keydown", onWindowKeyDown);

  if (!chatClient) {
    const identity = getLaunchIdentity();
    client.connect(chatWsUrl(identity, {
      location: window.location,
      searchParams: new URLSearchParams(window.location.search),
    }));
  }
  renderLog();

  return {
    sendGuildLine(body: string): boolean {
      const line = body.trim();
      if (!line || !isGuildMember(state)) return false;
      client.submitLine(`/guild ${line}`);
      return true;
    },
    selectGuildChannel(): boolean {
      if (!isGuildMember(state)) return false;
      sendChannel = "guild";
      applyChannel();
      input.focus();
      return true;
    },
    dispose() {
      cancelAnimationFrame(feedFrameId);
      window.removeEventListener("keydown", onWindowKeyDown);
      unsubscribe();
      client.dispose();
      if (window.__successor3dChatProbe === probe) delete window.__successor3dChatProbe;
      pane.remove();
    },
  };
}

function ref(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!element) throw new Error(`missing chat pane ref ${name}`);
  return element;
}

function wallClockStamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — tab choice stays session-local
  }
}
