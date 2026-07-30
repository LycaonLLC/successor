import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { AlphaControlStore } from "./control-store.js";
import { registerAlphaRoutes } from "./http.js";
import { CharacterStore } from "../game/characterStore.js";
import { LaunchSessionRegistry } from "../auth/runtime.js";

const origin = "https://alpha.example.test";
const headers = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("standalone alpha HTTP surface", () => {
  let dir: string;
  let app: FastifyInstance;
  let store: AlphaControlStore;
  let registry: LaunchSessionRegistry;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "successor-alpha-http-"));
    store = new AlphaControlStore({ dbPath: path.join(dir, "control.sqlite"), claimSecret: randomBytes(32), registrationOpen: true });
    app = Fastify();
    registry = new LaunchSessionRegistry();
    await registerAlphaRoutes(app, { controlStore: store, characterStore: new CharacterStore(path.join(dir, "characters.json")), sessionRevocations: registry, origin, shardId: "open-desert", clientReleaseId: "successor-alpha@a2d02071e180f9df", serverReleaseId: "dev", issuer: "test", acceptedClientReleaseIds: ["successor-alpha@a2d02071e180f9df", "successor-alpha"] });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates pre-session into an authenticated cookie and keeps the session projection public", async () => {
    const csrf = await app.inject({ method: "GET", url: "/alpha-api/csrf" });
    expect(csrf.statusCode).toBe(200);
    const cookie = csrf.headers["set-cookie"];
    const csrfToken = csrf.json().csrfToken as string;
    const registered = await app.inject({ method: "POST", url: "/alpha-api/register", headers: { ...headers, cookie, "x-csrf-token": csrfToken }, payload: { callsign: "bounty", password: "correct horse battery staple" } });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers["set-cookie"]).not.toBe(cookie);
    const session = await app.inject({ method: "GET", url: "/alpha-api/session", headers: { cookie: registered.headers["set-cookie"] } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).not.toHaveProperty("accountId");
    expect(session.json()).not.toHaveProperty("ownerRef");
  });

  it("rejects sibling origins and missing CSRF before a cookie mutation", async () => {
    const csrf = await app.inject({ method: "GET", url: "/alpha-api/csrf" });
    const response = await app.inject({ method: "POST", url: "/alpha-api/register", headers: { ...headers, origin: "https://evil.example.test", cookie: csrf.headers["set-cookie"] }, payload: { callsign: "bounty", password: "correct horse battery staple" } });
    expect(response.statusCode).toBe(403);
  });

  it("refuses spoofed forwarded client identity when no trusted proxy is configured", async () => {
    const response = await app.inject({ method: "GET", url: "/alpha-api/csrf", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "proxy_forbidden" });
  });

  it("returns split one-use launch capabilities only for an exact owned character", async () => {
    const csrf = await app.inject({ method: "GET", url: "/alpha-api/csrf" });
    const registered = await app.inject({ method: "POST", url: "/alpha-api/register", headers: { ...headers, cookie: csrf.headers["set-cookie"], "x-csrf-token": csrf.json().csrfToken }, payload: { callsign: "bounty", password: "correct horse battery staple" } });
    const cookie = registered.headers["set-cookie"];
    const freshCsrf = await app.inject({ method: "GET", url: "/alpha-api/csrf", headers: { cookie } });
    const created = await app.inject({ method: "POST", url: "/alpha-api/characters", headers: { ...headers, cookie, "x-csrf-token": freshCsrf.json().csrfToken }, payload: { name: "Bounty", appearance: { skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null }, initialProfessionId: "scout" } });
    expect(created.statusCode).toBe(201);
    const ticket = await app.inject({ method: "POST", url: "/alpha-api/play-ticket", headers: { ...headers, cookie, "x-csrf-token": freshCsrf.json().csrfToken }, payload: { characterId: created.json().id } });
    expect(ticket.statusCode).toBe(200);
    expect(ticket.json().gameTicket).not.toBe(ticket.json().chatTicket);
    expect(ticket.json()).toHaveProperty("characterId", created.json().id);
    expect(ticket.json()).not.toHaveProperty("launchId");
  });
});


describe("alpha cleanup lifecycle", () => {
  it("starts a bounded cleanup interval on ready and stops it on close", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "successor-alpha-cleanup-http-"));
    const localStore = new AlphaControlStore({ dbPath: path.join(dir, "control.sqlite"), claimSecret: randomBytes(32), registrationOpen: true });
    const localApp = Fastify();
    let calls = 0;
    const originalCleanup = localStore.cleanupExpired.bind(localStore);
    localStore.cleanupExpired = async (limit = 100) => { calls += 1; return originalCleanup(limit); };
    await registerAlphaRoutes(localApp, { controlStore: localStore, characterStore: new CharacterStore(path.join(dir, "characters.json")), sessionRevocations: new LaunchSessionRegistry(), origin, shardId: "open-desert", clientReleaseId: "dev", serverReleaseId: "dev", issuer: "test", cleanupIntervalMs: 10, cleanupBatchSize: 2 });
    vi.useFakeTimers();
    try {
      await localApp.ready();
      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toBeGreaterThanOrEqual(1);
      const beforeClose = calls;
      await localApp.close();
      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toBe(beforeClose);
    } finally {
      vi.useRealTimers();
      localStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("revocation closes active launch registry sessions", () => {
  it("closes browser launch sessions on logout and device launch sessions on device logout", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "successor-alpha-revoke-http-"));
    const localStore = new AlphaControlStore({ dbPath: path.join(dir, "control.sqlite"), claimSecret: randomBytes(32), registrationOpen: true });
    const localRegistry = new LaunchSessionRegistry();
    const localApp = Fastify();
    await registerAlphaRoutes(localApp, { controlStore: localStore, characterStore: new CharacterStore(path.join(dir, "characters.json")), sessionRevocations: localRegistry, origin, shardId: "open-desert", clientReleaseId: "dev", serverReleaseId: "dev", issuer: "test" });
    await localApp.ready();
    try {
      const csrf = await localApp.inject({ method: "GET", url: "/alpha-api/csrf" });
      const registered = await localApp.inject({ method: "POST", url: "/alpha-api/register", headers: { ...headers, cookie: csrf.headers["set-cookie"], "x-csrf-token": csrf.json().csrfToken }, payload: { callsign: "revoke-http", password: "correct horse battery staple" } });
      const cookieHeader = registered.headers["set-cookie"];
      const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)!;
      const token = cookie.split(";")[0]!.slice(cookie.split(";")[0]!.indexOf("=") + 1);
      const account = localStore.getAccount((await localStore.inspectSession(token)).accountId!);
      const browserSession = await localStore.inspectSession(token);
      const browserLaunch = await localStore.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "open-desert", clientReleaseId: "dev", serverReleaseId: "dev", issuer: "test", provenance: { kind: "browser_session", id: browserSession.sessionId } });
      let browserClosed = false;
      localRegistry.register({ launchId: browserLaunch.launchId, accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", issuer: "test" }, () => { browserClosed = true; });
      const freshCsrf = await localApp.inject({ method: "GET", url: "/alpha-api/csrf", headers: { cookie } });
      const logout = await localApp.inject({ method: "POST", url: "/alpha-api/logout", headers: { ...headers, cookie, "x-csrf-token": freshCsrf.json().csrfToken }, payload: {} });
      expect(logout.statusCode).toBe(204);
      expect(browserClosed).toBe(true);

      const device = await localStore.startDeviceAuthorization({ clientId: "tui", releaseId: "dev", scopes: ["play-ticket"] });
      await localStore.approveDevice(device.userCode, account.accountId);
      const exchanged = await localStore.pollDevice(device.deviceCode);
      const credential = exchanged.credential!;
      const inspected = await localStore.inspectDeviceCredential(credential);
      const deviceLaunch = await localStore.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "open-desert", clientReleaseId: "dev", serverReleaseId: "dev", issuer: "test", provenance: { kind: "device_credential", id: inspected.credentialId } });
      let deviceClosed = false;
      localRegistry.register({ launchId: deviceLaunch.launchId, accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", issuer: "test" }, () => { deviceClosed = true; });
      const deviceLogout = await localApp.inject({ method: "POST", url: "/alpha-api/device/logout", headers: { authorization: `Bearer ${credential}` } });
      expect(deviceLogout.statusCode).toBe(204);
      expect(deviceClosed).toBe(true);

      const accountSession = await localStore.createAuthSession(account.accountId);
      const accountLaunch = await localStore.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "open-desert", clientReleaseId: "dev", serverReleaseId: "dev", issuer: "test", provenance: { kind: "browser_session", id: (await localStore.inspectSession(accountSession.token)).sessionId } });
      let accountClosed = false;
      localRegistry.register({ launchId: accountLaunch.launchId, accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", issuer: "test" }, () => { accountClosed = true; });
      const accountDelete = await localApp.inject({ method: "DELETE", url: "/alpha-api/account", headers: { ...headers, cookie: `__Host-successor_session=${accountSession.token}`, "x-csrf-token": accountSession.csrfToken }, payload: { password: "correct horse battery staple" } });
      expect(accountDelete.statusCode).toBe(202);
      expect(accountClosed).toBe(true);
    } finally {
      await localApp.close();
      localStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
