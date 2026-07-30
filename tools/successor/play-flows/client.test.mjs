import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCharacterForPlay } from "./client.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("play-flow disposable character creation", () => {
  it("requires an explicit starter profession before issuing a create request", async () => {
    const requests = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ characters: [], server: "fixture" });
    });

    await expect(resolveCharacterForPlay({
      gameUrl: "http://127.0.0.1:28093",
      as: "FlowProbe",
    })).rejects.toThrow(/--profession must be marksman, scout, craftsman, medic, or brawler/u);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://127.0.0.1:28093/game/characters");
    expect(requests[0].init.method).toBeUndefined();
  });

  it("persists the normalized starter profession in the disposable character request", async () => {
    const requests = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const request = { url: String(url), init };
      requests.push(request);
      if (request.url.endsWith("/game/characters") && init.method === "POST") {
        return jsonResponse({ id: "flow-probe", name: "FlowProbe", ownerRef: "local" });
      }
      if (request.url.endsWith("/game/characters/flow-probe/enter")) {
        return jsonResponse({ ok: true, join: { actorId: "flow-probe", name: "FlowProbe", liveState: "offline" } });
      }
      return jsonResponse({ characters: [], server: "fixture" });
    });

    const resolved = await resolveCharacterForPlay({
      gameUrl: "http://127.0.0.1:28093/",
      as: "FlowProbe",
      profession: " Scout ",
    });

    expect(resolved.created).toBe(true);
    expect(resolved.character.id).toBe("flow-probe");
    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:28093/game/characters",
      "http://127.0.0.1:28093/game/characters",
      "http://127.0.0.1:28093/game/characters/flow-probe/enter",
    ]);
    expect(JSON.parse(requests[1].init.body)).toMatchObject({
      name: "FlowProbe",
      initialProfessionId: "scout",
    });
  });
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
