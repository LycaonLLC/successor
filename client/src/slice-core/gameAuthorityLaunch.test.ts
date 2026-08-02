import { describe, expect, it } from "vitest";
import { gameAuthorityJoinOptions } from "./gameAuthoritySystem";

describe("standalone game launch", () => {
  it("puts only the game capability in Colyseus join options", () => {
    expect(gameAuthorityJoinOptions({
      standalone: true,
      gameTicket: "game-secret",
      chatTicket: "chat-secret",
      clientReleaseId: "release-a",
      playerId: "char-1",
      displayName: "Atlas",
      ownerRef: "account-1",
      ownerDisplayName: "Atlas",
      zoneId: "open-desert",
      partyId: "",
      guildId: "",
      guildTag: null,
      characterId: "char-1",
      gameWsUrl: "wss://game.example.test/socket",
      chatWsUrl: "wss://chat.example.test/socket",
    })).toEqual({ gameTicket: "game-secret", release: "release-a" });
  });
});
