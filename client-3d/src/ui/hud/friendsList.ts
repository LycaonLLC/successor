import type { FriendPresence, PresenceState } from "@successor/client/src/chat/chatClient";

/**
 * FRIENDS list — model + DOM renderer for the chat pane's FRIENDS tab.
 *
 * Reads `ChatClientState.friends` as-is: entries are the characters YOU
 * listed (directed — being on this list says nothing about their list), and
 * the server already collapses anything it won't show into a plain
 * "offline". So a row is only ever a name + one of four statuses; there is
 * deliberately no other label vocabulary here.
 *
 * Order: reachable first (online, away, busy), offline last, alphabetical
 * within each band — the roster reads "who can I talk to" top-down.
 */

export interface FriendRowModel {
  id: string;
  name: string;
  status: PresenceState;
}

const STATUS_RANK: Record<PresenceState, number> = { online: 0, away: 1, busy: 2, offline: 3 };

export const FRIENDS_EMPTY_LINE = "NO FRIENDS LISTED";
export const FRIENDS_EMPTY_HINT = "/friend add Name";

export function friendsListModel(friends: readonly FriendPresence[]): FriendRowModel[] {
  return friends
    .map((friend) => ({ id: friend.id, name: friend.displayName, status: friend.status }))
    .sort((left, right) =>
      (STATUS_RANK[left.status] - STATUS_RANK[right.status])
      || left.name.localeCompare(right.name));
}

/** Repaint `host` with the current friends roster (small list — full repaint
 * on change is the same pattern as the chat log itself). */
export function renderFriendsList(host: HTMLElement, friends: readonly FriendPresence[]): void {
  host.textContent = "";
  const rows = friendsListModel(friends);
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sc3d-chat-friends-empty";
    const line = document.createElement("span");
    line.textContent = FRIENDS_EMPTY_LINE;
    const hint = document.createElement("code");
    hint.textContent = FRIENDS_EMPTY_HINT;
    empty.append(line, hint);
    host.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "sc3d-chat-friendrow";
    el.dataset.status = row.status;
    el.dataset.friendId = row.id;
    const dot = document.createElement("span");
    dot.className = "sc3d-chat-frienddot";
    const name = document.createElement("span");
    name.className = "sc3d-chat-friendname";
    name.textContent = row.name;
    const status = document.createElement("span");
    status.className = "sc3d-chat-friendstatus";
    status.textContent = row.status.toUpperCase();
    el.append(dot, name, status);
    host.appendChild(el);
  }
}
