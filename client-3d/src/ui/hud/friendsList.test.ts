// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { FriendPresence } from "@successor/client/src/chat/chatClient";

import { friendsListModel, renderFriendsList } from "./friendsList";

const friend = (name: string, status: FriendPresence["status"]): FriendPresence => ({
  id: `char_${name.toLowerCase()}`,
  displayName: name,
  status,
  since: "2026-07-16T00:00:00.000Z",
});

describe("friendsListModel", () => {
  it("orders reachable statuses first, offline last, alphabetical within bands", () => {
    const model = friendsListModel([
      friend("Zara", "online"),
      friend("Anders", "offline"),
      friend("Mara-Lyn", "busy"),
      friend("Brix", "away"),
      friend("Alto", "online"),
    ]);
    expect(model.map((row) => row.name)).toEqual(["Alto", "Zara", "Brix", "Mara-Lyn", "Anders"]);
  });
});

describe("renderFriendsList", () => {
  it("renders one row per directed friend with name and status", () => {
    const host = document.createElement("div");
    renderFriendsList(host, [friend("Zara", "online"), friend("Anders", "offline")]);
    const rows = host.querySelectorAll(".sc3d-chat-friendrow");
    expect(rows.length).toBe(2);
    const [first, second] = rows;
    expect(first!.querySelector(".sc3d-chat-friendname")!.textContent).toBe("Zara");
    expect(first!.querySelector(".sc3d-chat-friendstatus")!.textContent).toBe("ONLINE");
    expect((first as HTMLElement).dataset.status).toBe("online");
    expect(second!.querySelector(".sc3d-chat-friendname")!.textContent).toBe("Anders");
    expect(second!.querySelector(".sc3d-chat-friendstatus")!.textContent).toBe("OFFLINE");
  });

  it("repaints on update: a presence change moves and restyles the row", () => {
    const host = document.createElement("div");
    renderFriendsList(host, [friend("Zara", "online"), friend("Anders", "offline")]);
    renderFriendsList(host, [friend("Zara", "offline"), friend("Anders", "online")]);
    const rows = [...host.querySelectorAll<HTMLElement>(".sc3d-chat-friendrow")];
    expect(rows.map((row) => [row.querySelector(".sc3d-chat-friendname")!.textContent, row.dataset.status]))
      .toEqual([["Anders", "online"], ["Zara", "offline"]]);
  });

  it("shows only the four presence words — never a blocked/private label", () => {
    const host = document.createElement("div");
    renderFriendsList(host, [
      friend("Alto", "online"),
      friend("Brix", "away"),
      friend("Mara-Lyn", "busy"),
      friend("Zara", "offline"), // privacy-hidden arrives as ordinary offline
    ]);
    const words = [...host.querySelectorAll(".sc3d-chat-friendstatus")].map((el) => el.textContent);
    expect(words).toEqual(["ONLINE", "AWAY", "BUSY", "OFFLINE"]);
    expect(host.textContent).not.toMatch(/BLOCKED|PRIVATE|IGNORED|MUTUAL/iu);
  });

  it("renders a quiet empty state with the add hint", () => {
    const host = document.createElement("div");
    renderFriendsList(host, []);
    const empty = host.querySelector(".sc3d-chat-friends-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("NO FRIENDS LISTED");
    expect(empty!.textContent).toContain("/friend add Name");
    // A later snapshot replaces the empty state with rows.
    renderFriendsList(host, [friend("Zara", "online")]);
    expect(host.querySelector(".sc3d-chat-friends-empty")).toBeNull();
    expect(host.querySelectorAll(".sc3d-chat-friendrow").length).toBe(1);
  });
});
