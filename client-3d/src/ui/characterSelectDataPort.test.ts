import { afterEach, describe, expect, it } from "vitest";
import { createLegacyCharacterSelectDataPort } from "./characterSelectDataPort";

const responseRecord = {
  id: "char-1",
  ownerRef: "owner-1",
  name: "Marlow",
  appearance: { skinTone: "#d1a679", hair: null, hairMat: "hair_umber", face: null },
  position: null,
  lastLogoutAt: null,
  lastSeenAt: null,
  totalPlayMs: 0,
  liveState: "offline" as const,
  initialProfessionId: "scout" as const,
  worldEntryClaimed: false,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("legacy character select data port", () => {
  it("keeps the roster list/create/enter HTTP contract", async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const request = requests.at(-1)!;
      if (request.method === "GET") {
        return new Response(JSON.stringify({ server: { online: true }, characters: [responseRecord] }), { status: 200 });
      }
      if (request.method === "POST" && request.url.endsWith("/game/characters")) {
        return new Response(JSON.stringify(responseRecord), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true, join: { player: "p", actorId: "a" } }), { status: 200 });
    }) as typeof fetch;

    const port = createLegacyCharacterSelectDataPort("https://game.example");
    await expect(port.list()).resolves.toMatchObject({ characters: [{ id: "char-1" }] });
    await expect(port.create({ name: "Mara", appearance: responseRecord.appearance, initialProfessionId: "scout" })).resolves.toMatchObject({ ok: true });
    await expect(port.select("char-1")).resolves.toMatchObject({ ok: true, join: { actorId: "a" } });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://game.example/game/characters",
      "POST https://game.example/game/characters",
      "POST https://game.example/game/characters/char-1/enter",
    ]);
  });
});
