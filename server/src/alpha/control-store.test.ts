import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
type TestDatabase = {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown>;
    run(...params: unknown[]): unknown;
  };
  close(): void;
};
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => TestDatabase };
import { afterEach, describe, expect, it } from "vitest";
import {
  AlphaControlStore,
  ALPHA_KDF,
  MIGRATIONS,
  controlSchemaHeadCanUpgrade,
  migrationChecksumForTests,
} from "./control-store.js";

const roots: string[] = [];
const secret = Buffer.alloc(32, 0x11);
function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "successor-alpha-control-"));
  roots.push(root);
  return join(root, "control.sqlite");
}
function expectCode(work: () => unknown, code: string): void {
  expect(work).toThrowError(expect.objectContaining({ code }));
}
async function expectAsyncCode(work: () => Promise<unknown>, code: string): Promise<void> {
  await expect(work()).rejects.toMatchObject({ code });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("alpha control store startup and migrations", () => {
  it("accepts only the explicit additive v1-to-v2 durability lineage", () => {
    const v1 = {
      version: MIGRATIONS[0]!.version,
      checksum: migrationChecksumForTests(MIGRATIONS[0]!),
    };
    const v2 = {
      version: MIGRATIONS[1]!.version,
      checksum: migrationChecksumForTests(MIGRATIONS[1]!),
    };
    expect(controlSchemaHeadCanUpgrade(v1, v1)).toBe(true);
    expect(controlSchemaHeadCanUpgrade(v2, v2)).toBe(true);
    expect(controlSchemaHeadCanUpgrade(v1, v2)).toBe(true);
    expect(controlSchemaHeadCanUpgrade(v2, v1)).toBe(false);
    expect(controlSchemaHeadCanUpgrade({ ...v1, checksum: "bad" }, v2)).toBe(false);
    expect(controlSchemaHeadCanUpgrade({ version: 3, checksum: "future" }, v2)).toBe(false);
  });

  it("pins pragmas, persists WAL state, and reopens cleanly", async () => {
    const path = databasePath();
    const first = new AlphaControlStore({ dbPath: path, registrationOpen: true, claimSecret: secret });
    expect(first.auditPragmas()).toEqual({ journalMode: "wal", synchronous: 2, foreignKeys: 1, trustedSchema: 0, busyTimeoutMs: 5000 });
    expect(first.schemaHead()).toEqual({ version: MIGRATIONS.at(-1)!.version, checksum: migrationChecksumForTests(MIGRATIONS.at(-1)!) });
    await first.registerAccount({ callsign: "WAL_Test", password: "a password with enough length" });
    first.close();
    const second = new AlphaControlStore({ dbPath: path, registrationOpen: true, claimSecret: secret });
    expectCode(() => second.getAccount("missing"), "ALPHA_ACCOUNT_NOT_FOUND");
  });

  it("upgrades an existing v1 control database without resetting accounts", async () => {
    const path = databasePath();
    const v1 = new AlphaControlStore({
      dbPath: path,
      registrationOpen: true,
      claimSecret: secret,
      migrations: [MIGRATIONS[0]!],
    });
    const account = await v1.registerAccount({
      callsign: "migration_keeper",
      password: "account survives schema migration",
    });
    v1.close();

    const upgraded = new AlphaControlStore({ dbPath: path, claimSecret: secret });
    expect(upgraded.schemaHead()).toEqual({
      version: 2,
      checksum: migrationChecksumForTests(MIGRATIONS[1]!),
    });
    expect(upgraded.getAccount(account.accountId).callsign).toBe("migration_keeper");
    upgraded.close();
  });

  it("refuses definition checksum mismatch and corrupt, newer, or unknown state", async () => {
    const path = databasePath();
    expectCode(() => new AlphaControlStore({ dbPath: path, claimSecret: secret, migrations: [{ ...MIGRATIONS[0]!, checksum: "bad" }] }), "ALPHA_MIGRATION_CHECKSUM_MISMATCH");
    const seeded = new AlphaControlStore({ dbPath: path, claimSecret: secret });
    seeded.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE schema_migrations SET checksum='bad'").run();
    db.close();
    expectCode(() => new AlphaControlStore({ dbPath: path, claimSecret: secret }), "ALPHA_MIGRATION_CHECKSUM_MISMATCH");

    const newerPath = databasePath();
    const newerSeed = new AlphaControlStore({ dbPath: newerPath, claimSecret: secret });
    newerSeed.close();
    const newerDb = new DatabaseSync(newerPath);
    newerDb.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (4, 'future', 'future', 0)").run();
    newerDb.close();
    expectCode(() => new AlphaControlStore({ dbPath: newerPath, claimSecret: secret }), "ALPHA_MIGRATION_NEWER");

    const unknownPath = databasePath();
    const unknownSeed = new AlphaControlStore({ dbPath: unknownPath, claimSecret: secret });
    unknownSeed.close();
    const unknownDb = new DatabaseSync(unknownPath);
    unknownDb.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (0, 'unknown', 'unknown', 0)").run();
    unknownDb.close();
    expectCode(() => new AlphaControlStore({ dbPath: unknownPath, claimSecret: secret }), "ALPHA_MIGRATION_UNKNOWN");
  });
});

describe("player bug report persistence", () => {
  it("stores an idempotent, identity-bound report and redacts diagnostic secrets", async () => {
    const path = databasePath();
    const now = Date.UTC(2026, 6, 29, 18, 0, 0);
    const canonicalServerReleaseId = [
      "planetfall-v5-seed-424242-size-1024-rogues-18-desert-critters-48-verdance-critters-24",
      "areas-open-desert-overworld-verdance-forest-overworld",
    ].join("-");
    const store = new AlphaControlStore({
      dbPath: path,
      claimSecret: secret,
      registrationOpen: true,
      now: () => now,
    });
    const account = await store.registerAccount({
      callsign: "reporter",
      password: "a sufficiently useful password",
    });
    const launch = await store.createLaunch({
      accountId: account.accountId,
      ownerRef: account.ownerRef,
      characterId: "char_reporter",
      shardId: "open-desert",
      clientReleaseId: "client-test",
      serverReleaseId: canonicalServerReleaseId,
      issuer: "test",
      provenance: { kind: "browser_session", id: "session-report" },
    });
    const input = {
      requestId: "6e934dfe-e9da-4d15-8da4-e6e32b7d5ab8",
      accountId: account.accountId,
      ownerRef: account.ownerRef,
      characterId: "char_reporter",
      launchId: launch.launchId,
      shardId: "open-desert",
      clientReleaseId: "client-test",
      serverReleaseId: canonicalServerReleaseId,
      category: "gameplay" as const,
      body: "The extractor vanished after I placed it beside the shelter.",
      diagnostics: {
        schema: "successor.bug-report-diagnostics.v1",
        gameTicket: "must-not-survive",
        path: "/play?ticket=must-not-survive",
      },
    };

    const first = store.createBugReport(input);
    const retry = store.createBugReport(input);
    expect(retry).toEqual(first);
    expect(first.createdAt).toBe(now);

    const db = new DatabaseSync(path);
    const row = db.prepare(`
      SELECT report_id, account_id, owner_ref, character_id, launch_id, status,
             server_release_id, category, body, diagnostics_json
      FROM bug_reports
      WHERE request_id = ?
    `).get(input.requestId);
    expect(row).toMatchObject({
      report_id: first.reportId,
      account_id: account.accountId,
      owner_ref: account.ownerRef,
      character_id: "char_reporter",
      launch_id: launch.launchId,
      server_release_id: canonicalServerReleaseId,
      status: "open",
      category: "gameplay",
      body: input.body,
    });
    expect(JSON.parse(String(row.diagnostics_json))).toEqual({
      schema: "successor.bug-report-diagnostics.v1",
      gameTicket: "[redacted]",
      path: "/play?ticket=[redacted]",
    });
    db.close();
    store.close();
  });
});

describe("registration, password KDF, and sessions", () => {
  it("normalizes callsigns, enforces closed/capped registration, and handles races", async () => {
    const closed = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret });
    await expectAsyncCode(() => closed.registerAccount({ callsign: "closed_one", password: "password" }), "ALPHA_REGISTRATION_CLOSED");
    closed.close();
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, registrationCap: 1 });
    const results = await Promise.allSettled([
      store.registerAccount({ callsign: " Alpha-One ", password: "password one" }),
      store.registerAccount({ callsign: "alpha-two", password: "password two" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const account = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.registerAccount>>> => result.status === "fulfilled")!.value;
    expect(["alpha-one", "alpha-two"]).toContain(account.callsign);
    await expectAsyncCode(() => store.registerAccount({ callsign: "ALPHA_ONE", password: "another password" }), "ALPHA_REGISTRATION_CAP");
  });

  it("counts only active accounts toward registration capacity", async () => {
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, registrationCap: 1 });
    const held = await store.registerAccount({ callsign: "capacity-held", password: "correct password" });
    await expectAsyncCode(() => store.registerAccount({ callsign: "capacity-blocked", password: "correct password" }), "ALPHA_REGISTRATION_CAP");
    await store.revokeAccount(held.accountId);
    expect(store.getAccount(held.accountId).status).toBe("pending_deletion");
    const freed = await store.registerAccount({ callsign: "capacity-freed", password: "correct password" });
    expect(freed.status).toBe("active");
    expect(freed.callsign).toBe("capacity-freed");
    // Cap-first precedence: full active set returns ALPHA_REGISTRATION_CAP before UNIQUE checks.
    await expectAsyncCode(() => store.registerAccount({ callsign: "capacity-again", password: "correct password" }), "ALPHA_REGISTRATION_CAP");

    // Deleted callsign uniqueness while an active slot remains (so UNIQUE is observable).
    const unique = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, registrationCap: 2 });
    const tombstone = await unique.registerAccount({ callsign: "kept-callsign", password: "correct password" });
    await unique.revokeAccount(tombstone.accountId);
    expect(unique.getAccount(tombstone.accountId).status).toBe("pending_deletion");
    await expectAsyncCode(() => unique.registerAccount({ callsign: "kept-callsign", password: "correct password" }), "ALPHA_CALLSIGN_TAKEN");
    const other = await unique.registerAccount({ callsign: "fresh-callsign", password: "correct password" });
    expect(other.status).toBe("active");
    expect(other.callsign).toBe("fresh-callsign");

    // Concurrent registration admits only free active slots after pending_deletion tombstones.
    const second = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, registrationCap: 2 });
    const activeA = await second.registerAccount({ callsign: "mix-active-a", password: "correct password" });
    const activeB = await second.registerAccount({ callsign: "mix-active-b", password: "correct password" });
    await second.revokeAccount(activeA.accountId);
    await second.revokeAccount(activeB.accountId);
    expect(second.getAccount(activeA.accountId).status).toBe("pending_deletion");
    expect(second.getAccount(activeB.accountId).status).toBe("pending_deletion");
    const winners = await Promise.allSettled([
      second.registerAccount({ callsign: "mix-race-one", password: "correct password" }),
      second.registerAccount({ callsign: "mix-race-two", password: "correct password" }),
      second.registerAccount({ callsign: "mix-race-three", password: "correct password" }),
    ]);
    expect(winners.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(winners.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = winners.find((result): result is PromiseRejectedResult => result.status === "rejected")!;
    expect(rejected.reason).toMatchObject({ code: "ALPHA_REGISTRATION_CAP" });
  });

  it("does dummy work for unknown callsigns and rotates, expires, and revokes sessions", async () => {
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true });
    const account = await store.registerAccount({ callsign: "kdf-user", password: "correct password" });
    const good = await store.authenticate("KDF-USER", "correct password");
    expect(good.account.accountId).toBe(account.accountId);
    expect(good.rehashed).toBe(false);
    await expectAsyncCode(() => store.authenticate("unknown-user", "correct password"), "ALPHA_PASSWORD_INVALID");
    await expectAsyncCode(() => store.authenticate("kdf-user", "wrong password"), "ALPHA_PASSWORD_INVALID");
    expect(ALPHA_KDF).toMatchObject({ version: 1, N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

    let now = Date.now();
    const clocked = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, now: () => now });
    const registered = await clocked.registerAccount({ callsign: "session-user", password: "correct password" });
    const pre = await clocked.createPreAuthSession();
    const auth = await clocked.rotateSession(pre.token, registered.accountId);
    await expectAsyncCode(() => clocked.inspectSession(pre.token), "ALPHA_SESSION_INVALID");
    expect((await clocked.inspectSession(auth.token, auth.csrfToken)).accountId).toBe(registered.accountId);
    await clocked.revokeSession(auth.token);
    await expectAsyncCode(() => clocked.inspectSession(auth.token), "ALPHA_SESSION_INVALID");
    const expiring = await clocked.createAuthSession(registered.accountId);
    now += 31 * 24 * 60 * 60 * 1000;
    await expectAsyncCode(() => clocked.inspectSession(expiring.token), "ALPHA_SESSION_EXPIRED");
  });
});

describe("devices, launches, and deletion", () => {
  it("implements device pending, slow_down, approval, one credential, and revoke", async () => {
    let now = Date.now();
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, now: () => now });
    const account = await store.registerAccount({ callsign: "device-user", password: "correct password" });
    const device = await store.startDeviceAuthorization({ clientId: "tui", releaseId: "release-1", scopes: ["character:list", "play-ticket"] });
    expect((await store.pollDevice(device.deviceCode)).status).toBe("pending");
    expect((await store.pollDevice(device.deviceCode)).status).toBe("slow_down");
    await store.approveDevice(device.userCode, account.accountId);
    now += 10_000;
    const exchanged = await store.pollDevice(device.deviceCode);
    expect(exchanged.status).toBe("exchanged");
    expect(exchanged.credential).toBeTruthy();
    await expectAsyncCode(() => store.pollDevice(device.deviceCode).then(() => undefined), "ALPHA_DEVICE_STATE");
    const credential = exchanged.credential!;
    expect((await store.inspectDeviceCredential(credential)).accountId).toBe(account.accountId);
    await store.revokeDeviceCredential(credential);
    await expectAsyncCode(() => store.inspectDeviceCredential(credential), "ALPHA_CREDENTIAL_INVALID");
  });

  it("redeems each launch purpose atomically and checks bindings, expiry, release, shard, and revoke", async () => {
    let now = Date.now();
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, now: () => now, requiredLegalVersions: { terms: "2026-01" } });
    const account = await store.registerAccount({ callsign: "launch-user", password: "correct password" });
    const provenance = { kind: "browser_session" as const, id: "session-a" };
    await expectAsyncCode(() => store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard-a", clientReleaseId: "client-a", serverReleaseId: "server-a", issuer: "issuer", provenance }), "ALPHA_LEGAL_REQUIRED");
    await store.acceptLegal(account.accountId, "terms", "2026-01");
    const launch = await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard-a", clientReleaseId: "client-a", serverReleaseId: "server-a", issuer: "issuer", provenance });
    const redeem = { token: launch.gameTicket, purpose: "game" as const, accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard-a", clientReleaseId: "client-a", serverReleaseId: "server-a", issuer: "issuer" };
    const winners = await Promise.allSettled([store.redeemLaunch(redeem), store.redeemLaunch(redeem)]);
    expect(winners.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(winners.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expectAsyncCode(() => store.redeemLaunch(redeem), "ALPHA_LAUNCH_REPLAY");
    await expectAsyncCode(() => store.redeemLaunch({ ...redeem, token: launch.chatTicket, purpose: "chat", clientReleaseId: "wrong" }), "ALPHA_LAUNCH_INVALID");
    const revoked = await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard-a", clientReleaseId: "client-a", serverReleaseId: "server-a", issuer: "issuer", provenance });
    await store.revokeLaunch(revoked.launchId, account.accountId);
    await expectAsyncCode(() => store.redeemLaunch({ ...redeem, token: revoked.chatTicket, purpose: "chat" }), "ALPHA_LAUNCH_INVALID");
    const expired = await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard-a", clientReleaseId: "client-a", serverReleaseId: "server-a", issuer: "issuer", provenance });
    now += 46_000;
    await expectAsyncCode(() => store.redeemLaunch({ ...redeem, token: expired.gameTicket }), "ALPHA_LAUNCH_INVALID");
  });

  it("tombstones accounts and revokes only control state", async () => {
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true });
    const account = await store.registerAccount({ callsign: "delete-user", password: "correct password" });
    const session = await store.createAuthSession(account.accountId);
    const device = await store.startDeviceAuthorization({ clientId: "desktop", releaseId: "release", scopes: ["character:list"] });
    await store.approveDevice(device.userCode, account.accountId);
    await store.revokeAccount(account.accountId);
    expect(store.getAccount(account.accountId).status).toBe("pending_deletion");
    await expectAsyncCode(() => store.inspectSession(session.token), "ALPHA_SESSION_INVALID");
    await expectAsyncCode(() => store.createAuthSession(account.accountId), "ALPHA_ACCOUNT_DELETED");
    expect(store.getAccount(account.accountId).ownerRef).toBe(account.ownerRef);
  });
});


describe("bounded device authorizations", () => {
  it("caps pending devices, expires stale capacity, and ignores terminal states", async () => {
    let now = Date.now();
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, now: () => now, maxOutstandingDeviceAuthorizations: 1 });
    const account = await store.registerAccount({ callsign: "device-cap", password: "correct password" });
    const pending = await store.startDeviceAuthorization({ clientId: "tui", releaseId: "release", scopes: ["character:list"] });
    await expectAsyncCode(() => store.startDeviceAuthorization({ clientId: "desktop", releaseId: "release", scopes: ["character:list"] }), "ALPHA_DEVICE_CAP");
    now += 10 * 60 * 1000;
    const expiredCapacity = await store.startDeviceAuthorization({ clientId: "desktop", releaseId: "release", scopes: ["character:list"] });
    await store.denyDevice(expiredCapacity.userCode);
    const deniedFreed = await store.startDeviceAuthorization({ clientId: "desktop", releaseId: "release", scopes: ["character:list"] });
    await store.approveDevice(deniedFreed.userCode, account.accountId);
    now += 5_000;
    expect((await store.pollDevice(deniedFreed.deviceCode)).status).toBe("exchanged");
    await store.startDeviceAuthorization({ clientId: "desktop", releaseId: "release", scopes: ["character:list"] });
    expect(pending.authorizationId).not.toBe(expiredCapacity.authorizationId);
  });
});

describe("provenance revocation, bounded minting, and cleanup", () => {
  it("atomically revokes device launches and browser-session launches", async () => {
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true });
    const account = await store.registerAccount({ callsign: "provenance-user", password: "correct password" });
    const device = await store.startDeviceAuthorization({ clientId: "desktop", releaseId: "release", scopes: ["play-ticket"] });
    await store.approveDevice(device.userCode, account.accountId);
    const exchanged = await store.pollDevice(device.deviceCode);
    const credential = exchanged.credential!;
    const deviceLaunch = await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "issuer", provenance: { kind: "device_credential", id: (await store.inspectDeviceCredential(credential)).credentialId } });
    const auth = await store.createAuthSession(account.accountId);
    const browserLaunch = await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "issuer", provenance: { kind: "browser_session", id: auth.token ? (await store.inspectSession(auth.token)).sessionId : "missing" } });
    expect((await store.revokeDeviceCredential(credential)).launchIds).toEqual([deviceLaunch.launchId]);
    await expectAsyncCode(() => store.redeemCapability({ token: deviceLaunch.gameTicket, purpose: "game", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "issuer" }), "ALPHA_LAUNCH_INVALID");
    expect((await store.revokeSession(auth.token)).launchIds).toEqual([browserLaunch.launchId]);
    await expectAsyncCode(() => store.redeemCapability({ token: browserLaunch.gameTicket, purpose: "game", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "issuer" }), "ALPHA_LAUNCH_INVALID");
  });

  it("enforces account, issuer, device and per-account mint caps, plus poll attempts", async () => {
    let now = Date.now();
    const store = new AlphaControlStore({ dbPath: databasePath(), claimSecret: secret, registrationOpen: true, now: () => now, maxOutstandingLaunchesPerAccount: 2, maxOutstandingLaunchesPerIssuer: 1, maxOutstandingLaunchesPerDevice: 1, playTicketMintLimitPerAccount: 2, devicePollAttemptCap: 1 });
    const account = await store.registerAccount({ callsign: "bounded-user", password: "correct password" });
    const first = await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "issuer", provenance: { kind: "browser_session", id: "session-a" } });
    await expectAsyncCode(() => store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "issuer", provenance: { kind: "browser_session", id: "session-b" } }), "ALPHA_LAUNCH_CAP");
    await store.revokeLaunch(first.launchId, account.accountId);
    await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "other", provenance: { kind: "browser_session", id: "session-b" } });
    await expectAsyncCode(() => store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "third", provenance: { kind: "browser_session", id: "session-c" } }), "ALPHA_PLAY_TICKET_RATE");
    const device = await store.startDeviceAuthorization({ clientId: "tui", releaseId: "release", scopes: ["character:list"] });
    expect((await store.pollDevice(device.deviceCode)).status).toBe("pending");
    now += 5_000;
    expect((await store.pollDevice(device.deviceCode)).status).toBe("expired");
  });

  it("deletes bounded expired rows during cleanup", async () => {
    const now = Date.now();
    const path = databasePath();
    const store = new AlphaControlStore({ dbPath: path, claimSecret: secret, registrationOpen: true, now: () => now });
    const account = await store.registerAccount({ callsign: "cleanup-user", password: "correct password" });
    const session = await store.createAuthSession(account.accountId);
    await store.revokeSession(session.token);
    const denied = await store.startDeviceAuthorization({ clientId: "tui", releaseId: "release", scopes: ["character:list"] });
    await store.denyDevice(denied.userCode);
    const launch = await store.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: "char", shardId: "shard", clientReleaseId: "client", serverReleaseId: "server", issuer: "issuer", provenance: { kind: "browser_session", id: "cleanup-session" } });
    await store.revokeLaunch(launch.launchId, account.accountId);
    expect(await store.cleanupExpired(1)).toBe(3);
    const db = new DatabaseSync(path);
    expect(Number(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count)).toBe(0);
    expect(Number(db.prepare("SELECT COUNT(*) AS count FROM device_authorizations").get().count)).toBe(0);
    expect(Number(db.prepare("SELECT COUNT(*) AS count FROM launches").get().count)).toBe(0);
    db.close();
  });
});
