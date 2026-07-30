import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { AlphaControlStore } from "./control-store.js";
import { registerAlphaRoutes } from "./http.js";
import {
  CharacterStore,
  successorMacrosRecordKind,
  type SuccessorMacroRecord,
} from "../game/characterStore.js";
import { LaunchSessionRegistry } from "../auth/runtime.js";

const origin = "https://alpha.example.test";
const headers = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
const appearance = {
  skinTone: "#c78f62",
  hair: "hair_mop",
  hairMat: "hair_raven",
  face: null,
};

describe("alpha hosted macro CRUD", () => {
  let dir: string;
  let app: FastifyInstance;
  let store: AlphaControlStore;
  let characters: CharacterStore;
  let registry: LaunchSessionRegistry;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "successor-alpha-macros-"));
    store = new AlphaControlStore({
      dbPath: path.join(dir, "control.sqlite"),
      claimSecret: randomBytes(32),
      registrationOpen: true,
    });
    characters = new CharacterStore(path.join(dir, "characters.json"));
    app = Fastify();
    registry = new LaunchSessionRegistry();
    await registerAlphaRoutes(app, {
      controlStore: store,
      characterStore: characters,
      sessionRevocations: registry,
      origin,
      shardId: "open-desert",
      clientReleaseId: "dev",
      serverReleaseId: "dev",
      issuer: "test",
      rateLimits: { macros: 8 },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function authedSession(callsign = "macroist"): Promise<{ cookie: string; csrf: string; ownerRef: string; accountId: string }> {
    const csrfRes = await app.inject({ method: "GET", url: "/alpha-api/csrf" });
    const registered = await app.inject({
      method: "POST",
      url: "/alpha-api/register",
      headers: { ...headers, cookie: csrfRes.headers["set-cookie"], "x-csrf-token": csrfRes.json().csrfToken },
      payload: { callsign, password: "correct horse battery staple" },
    });
    expect(registered.statusCode).toBe(201);
    const cookieHeader = registered.headers["set-cookie"];
    const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)!;
    const token = cookie.split(";")[0]!.slice(cookie.split(";")[0]!.indexOf("=") + 1);
    const session = await store.inspectSession(decodeURIComponent(token));
    const account = store.getAccount(session.accountId!);
    const fresh = await app.inject({ method: "GET", url: "/alpha-api/csrf", headers: { cookie } });
    return {
      cookie,
      csrf: fresh.json().csrfToken as string,
      ownerRef: account.ownerRef,
      accountId: account.accountId,
    };
  }

  async function createOwnedCharacter(session: { cookie: string; csrf: string }, name = "Atlas"): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/alpha-api/characters",
      headers: { ...headers, cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: { name, appearance, initialProfessionId: "scout" },
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  it("rejects missing, expired, and revoked sessions on macro GET/mutations", async () => {
    const missing = await app.inject({ method: "GET", url: "/alpha-api/characters/char_x/macros" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: "invalid_session" });

    const session = await authedSession("sess-macro");
    const characterId = await createOwnedCharacter(session);
    const tokenPart = session.cookie.split(";")[0]!;
    const raw = decodeURIComponent(tokenPart.slice(tokenPart.indexOf("=") + 1));
    await store.revokeSession(raw);

    const getRevoked = await app.inject({
      method: "GET",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: { cookie: session.cookie },
    });
    expect(getRevoked.statusCode).toBe(401);

    const postRevoked = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: { ...headers, cookie: session.cookie, "x-csrf-token": session.csrf, "if-match": "deadbeefdeadbeef" },
      payload: { id: "a", name: "A", iconId: "macro:a", body: "/pause 1" },
    });
    expect(postRevoked.statusCode).toBe(401);
  });

  it("requires CSRF, exact origin, and same-origin fetch metadata on macro mutations", async () => {
    const session = await authedSession("csrf-macro");
    const characterId = await createOwnedCharacter(session);
    const list = await app.inject({
      method: "GET",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: { cookie: session.cookie },
    });
    const etag = list.json().etag as string;

    const noCsrf = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: { ...headers, cookie: session.cookie, "if-match": etag },
      payload: { id: "a", name: "A", iconId: "macro:a", body: "/pause 1" },
    });
    expect(noCsrf.statusCode).toBe(401);

    const evilOrigin = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: {
        ...headers,
        origin: "https://evil.example.test",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "if-match": etag,
      },
      payload: { id: "a", name: "A", iconId: "macro:a", body: "/pause 1" },
    });
    expect(evilOrigin.statusCode).toBe(403);
    expect(evilOrigin.json()).toEqual({ error: "request_forbidden" });

    const crossSite = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: {
        ...headers,
        "sec-fetch-site": "cross-site",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "if-match": etag,
      },
      payload: { id: "a", name: "A", iconId: "macro:a", body: "/pause 1" },
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it("resolves owner server-side, isolates owners, and never enumerates foreign/deleted characters", async () => {
    const alice = await authedSession("alice-macro");
    const bob = await authedSession("bob-macro");
    const aliceChar = await createOwnedCharacter(alice, "Alice");
    const bobChar = await createOwnedCharacter(bob, "Bobby");

    const aliceList = await app.inject({
      method: "GET",
      url: `/alpha-api/characters/${aliceChar}/macros`,
      headers: { cookie: alice.cookie },
    });
    expect(aliceList.statusCode).toBe(200);
    expect(aliceList.json()).not.toHaveProperty("ownerRef");
    expect(aliceList.json()).not.toHaveProperty("accountId");
    expect(JSON.stringify(aliceList.json())).not.toMatch(/csrf|session|ownerRef|accountId/iu);

    const foreignGet = await app.inject({
      method: "GET",
      url: `/alpha-api/characters/${aliceChar}/macros`,
      headers: { cookie: bob.cookie },
    });
    expect(foreignGet.statusCode).toBe(404);
    expect(foreignGet.json()).toEqual({ error: "character_not_found" });

    const foreignPost = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${aliceChar}/macros`,
      headers: {
        ...headers,
        cookie: bob.cookie,
        "x-csrf-token": bob.csrf,
        "if-match": aliceList.json().etag,
      },
      payload: { id: "steal", name: "Steal", iconId: "macro:x", body: "/pause 1" },
    });
    expect(foreignPost.statusCode).toBe(404);
    expect(foreignPost.json()).toEqual({ error: "character_not_found" });

    // Seed alice macro under her owner, then delete character and re-check 404.
    const saved = characters.saveRecordKindItem<SuccessorMacroRecord>(
      aliceChar,
      successorMacrosRecordKind,
      { id: "scan", name: "Scan", iconId: "macro:scan", body: "/pause 1" },
      { ownerRef: alice.ownerRef, expectedEtag: aliceList.json().etag, requireEtag: true },
    );
    expect(saved.ok).toBe(true);
    characters.delete(aliceChar, alice.ownerRef);
    const deletedGet = await app.inject({
      method: "GET",
      url: `/alpha-api/characters/${aliceChar}/macros`,
      headers: { cookie: alice.cookie },
    });
    expect(deletedGet.statusCode).toBe(404);
    expect(deletedGet.json()).toEqual({ error: "character_not_found" });

    // Bob still sees only his empty list.
    const bobList = await app.inject({
      method: "GET",
      url: `/alpha-api/characters/${bobChar}/macros`,
      headers: { cookie: bob.cookie },
    });
    expect(bobList.statusCode).toBe(200);
    expect(bobList.json().macros).toEqual([]);
  });

  it("supports ETag create/update/delete and returns full payload on stale 409 without mutation", async () => {
    const session = await authedSession("etag-macro");
    const characterId = await createOwnedCharacter(session);
    const empty = await app.inject({
      method: "GET",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: { cookie: session.cookie },
    });
    expect(empty.statusCode).toBe(200);
    const emptyEtag = empty.json().etag as string;
    expect(empty.headers.etag).toBe(`"${emptyEtag}"`);

    const created = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: {
        ...headers,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "if-match": emptyEtag,
      },
      payload: { id: "heal_self", name: "Heal Self", iconId: "macro:medic", body: "/heal" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().macros).toHaveLength(1);
    expect(created.json().macro).toMatchObject({ id: "heal_self", body: "/heal" });
    const createdEtag = created.json().etag as string;
    expect(createdEtag).not.toBe(emptyEtag);

    const stale = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: {
        ...headers,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "if-match": emptyEtag,
      },
      payload: { id: "heal_self", name: "Heal Self", iconId: "macro:medic", body: "/heal\n/pause 1" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("etag_mismatch");
    expect(stale.json().etag).toBe(createdEtag);
    expect(stale.json().macros[0].body).toBe("/heal");

    const still = characters.listRecordKindItems(characterId, successorMacrosRecordKind, session.ownerRef);
    expect(still).toEqual([expect.objectContaining({ body: "/heal" })]);

    const updated = await app.inject({
      method: "POST",
      url: `/alpha-api/characters/${characterId}/macros`,
      headers: {
        ...headers,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "if-match": createdEtag,
      },
      payload: { id: "heal_self", name: "Heal Self", iconId: "macro:medic", body: "/heal\n/pause 1" },
    });
    expect(updated.statusCode).toBe(200);
    const updatedEtag = updated.json().etag as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/alpha-api/characters/${characterId}/macros/heal_self`,
      headers: {
        ...headers,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "if-match": updatedEtag,
      },
      payload: {},
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().macros).toEqual([]);
    expect(deleted.json().etag).toBe(emptyEtag);
  });

  it("rate-limits macro operations by authenticated account/session and character", async () => {
    const session = await authedSession("rate-macro");
    const characterId = await createOwnedCharacter(session);
    let limited = 0;
    for (let i = 0; i < 20; i += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/alpha-api/characters/${characterId}/macros`,
        headers: { cookie: session.cookie },
      });
      if (response.statusCode === 429) {
        limited += 1;
        expect(response.json()).toMatchObject({ error: "macro_rate_limited" });
      }
    }
    expect(limited).toBeGreaterThan(0);
  });
});
