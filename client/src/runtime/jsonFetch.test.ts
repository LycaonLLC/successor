import { describe, expect, it } from "vitest";

import { fetchJson } from "./jsonFetch";

describe("fetchJson", () => {
  it("loads JSON through an injectable fetcher", async () => {
    const payload = await fetchJson<{ ok: true }>("/fixture.json", async (path) => ({
      ok: path === "/fixture.json",
      status: 200,
      json: async () => ({ ok: true }),
    } as Response));

    expect(payload).toEqual({ ok: true });
  });

  it("reports the path and response status on failure", async () => {
    await expect(fetchJson("/missing.json", async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response))).rejects.toThrow("failed to fetch /missing.json: 404");
  });
});
