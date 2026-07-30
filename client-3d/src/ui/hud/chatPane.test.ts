// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatClient } from "@successor/client/src/chat/chatClient";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import type { PlayState } from "@successor/client/src/slice-core/gameState";

import { mountChatPane } from "./chatPane";

const self = {
  id: "char_atlas",
  displayName: "Atlas",
  status: "online" as const,
  since: "2026-07-29T00:00:00.000Z",
};

function playState(): PlayState {
  return {
    playerActorId: self.id,
    serverAuthority: {
      playerActorId: self.id,
      group: { group: null, members: [], pendingInvite: null },
      guilds: { guild: null, roster: [], pendingInvites: [], directory: [] },
    },
  } as unknown as PlayState;
}

function silentSfx(): SfxPlayer {
  return {
    probe: {
      ready: true,
      unlocked: true,
      clipCount: 0,
      lastPlayed: null,
      listener: null,
      lastDistanceCells: null,
      lastPan: 0,
      lastGain: 1,
      errors: [],
    },
    load: async () => undefined,
    setListenerPosition: () => undefined,
    play: () => undefined,
    playAt: () => undefined,
  };
}

describe("chatPane global channel", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.body.textContent = "";
    vi.restoreAllMocks();
  });

  it("provides a GLOBAL feed tab and a GLOBAL send-channel stop", () => {
    const client = createChatClient({ self, zoneId: "open-desert-overworld" });
    const submit = vi.spyOn(client, "submitLine").mockImplementation(() => undefined);
    const shell = document.createElement("div");
    document.body.appendChild(shell);
    const pane = mountChatPane(shell, playState(), silentSfx(), undefined, undefined, undefined, client);

    client.injectMessage({
      id: "local-1",
      channel: "local",
      sender: { id: "char_beryl", displayName: "Beryl" },
      body: "nearby line",
    });
    client.injectMessage({
      id: "global-1",
      channel: "global",
      sender: { id: "char_cairo", displayName: "Cairo" },
      body: "whole shard line",
    });

    const globalTab = shell.querySelector<HTMLButtonElement>('[data-tab="global"]')!;
    globalTab.click();
    const log = shell.querySelector<HTMLElement>('[data-ref="log"]')!;
    expect(globalTab.getAttribute("aria-selected")).toBe("true");
    expect(log.textContent).toContain("whole shard line");
    expect(log.textContent).not.toContain("nearby line");

    const channel = shell.querySelector<HTMLButtonElement>('[data-ref="channel"]')!;
    channel.click(); // LOCAL -> ZONE
    channel.click(); // ZONE -> GLOBAL
    expect(channel.textContent).toBe("GLOBAL");
    const input = shell.querySelector<HTMLInputElement>('[data-ref="input"]')!;
    input.value = "hello everyone";
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", bubbles: true }));
    expect(submit).toHaveBeenCalledWith("hello everyone");

    pane.dispose();
  });
});
