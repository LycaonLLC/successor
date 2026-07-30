import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runAccount, runLogin, runLogout } from "./accountCommands";
import type { AlphaApi, DevicePoll } from "./alphaApi";
import { CREDENTIAL_FILE, loadCredential, saveCredential } from "./credentialStore";

const CREDENTIAL = "credential-secret-00000000000000000000000001";
const OLD_CREDENTIAL = "old-credential-000000000000000000000000001";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function scratchDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "successor-acct-"));
  roots.push(root);
  return path.join(root, "successor");
}

interface Fake {
  api: AlphaApi;
  lines: string[];
  errors: string[];
  revoked: string[];
}

function fake(poll: DevicePoll = { status: "exchanged", credential: CREDENTIAL, scopes: ["character:list", "play-ticket"] }): Fake {
  const state: Fake = { lines: [], errors: [], revoked: [], api: null as unknown as AlphaApi };
  state.api = {
    apiUrl: "http://127.0.0.1:9999",
    connectUrl: "http://127.0.0.1:9999/connect",
    async deviceStart() {
      return { deviceCode: "device-code-secret-0000000000000000000001", userCode: "CODE123456", expiresAt: Date.now() + 600_000, pollIntervalMs: 5_000 };
    },
    async devicePoll() { return poll; },
    async deviceLogout(credential) {
      state.revoked.push(credential);
      return "revoked" as const;
    },
    async listCharacters() {
      return [{ id: "char_vex", name: "Vex Marrow", initialProfessionId: "scout", worldEntryClaimed: true }];
    },
    async playTicket() { throw new Error("not under test"); },
  };
  return state;
}

function deps(state: Fake, dir: string) {
  return {
    io: { print: (line: string) => state.lines.push(line), error: (line: string) => state.errors.push(line) },
    store: { dir },
    makeApi: () => state.api,
    sleep: async () => {},
    releaseId: "dev",
  };
}

const ACCOUNT = { apiUrl: "http://127.0.0.1:9999", openBrowser: false };

describe("successor-tui login", () => {
  it("stores the exchanged credential with strict modes and never prints it", async () => {
    const dir = await scratchDir();
    const state = fake();
    expect(await runLogin(ACCOUNT, deps(state, dir))).toBe(0);
    const file = path.join(dir, CREDENTIAL_FILE);
    expect(((await stat(file)).mode & 0o777)).toBe(0o600);
    const loaded = await loadCredential({ dir });
    expect(loaded!.credential).toBe(CREDENTIAL);
    const visible = [...state.lines, ...state.errors].join("\n");
    expect(visible).toContain("CODE123456");
    expect(visible).not.toContain(CREDENTIAL);
  });

  it("replaces an older credential and retires it server-side", async () => {
    const dir = await scratchDir();
    await saveCredential({ apiUrl: "http://127.0.0.1:9999", credential: OLD_CREDENTIAL, scopes: ["character:list"], obtainedAt: new Date().toISOString() }, { dir });
    const state = fake();
    expect(await runLogin(ACCOUNT, deps(state, dir))).toBe(0);
    expect(state.revoked).toEqual([OLD_CREDENTIAL]);
    expect((await loadCredential({ dir }))!.credential).toBe(CREDENTIAL);
  });

  it("reports a denial without storing anything", async () => {
    const dir = await scratchDir();
    const state = fake({ status: "denied" });
    expect(await runLogin(ACCOUNT, deps(state, dir))).toBe(1);
    await expect(access(path.join(dir, CREDENTIAL_FILE))).rejects.toThrow();
  });
});

describe("successor-tui logout", () => {
  it("revokes on the server and removes the file", async () => {
    const dir = await scratchDir();
    await saveCredential({ apiUrl: "http://127.0.0.1:9999", credential: CREDENTIAL, scopes: ["play-ticket"], obtainedAt: new Date().toISOString() }, { dir });
    const state = fake();
    expect(await runLogout(ACCOUNT, deps(state, dir))).toBe(0);
    expect(state.revoked).toEqual([CREDENTIAL]);
    expect(await loadCredential({ dir })).toBeNull();
    expect(state.lines.join("\n")).toContain("revoked on the server");
  });

  it("still removes the file when the server cannot confirm, and says so", async () => {
    const dir = await scratchDir();
    await saveCredential({ apiUrl: "http://127.0.0.1:9999", credential: CREDENTIAL, scopes: ["play-ticket"], obtainedAt: new Date().toISOString() }, { dir });
    const state = fake();
    state.api.deviceLogout = async () => { throw new Error("network down"); };
    expect(await runLogout(ACCOUNT, deps(state, dir))).toBe(0);
    expect(await loadCredential({ dir })).toBeNull();
    expect(state.lines.join("\n")).toContain("could not confirm");
  });

  it("is calm when nothing is stored", async () => {
    const dir = await scratchDir();
    const state = fake();
    expect(await runLogout(ACCOUNT, deps(state, dir))).toBe(0);
    expect(state.lines.join("\n")).toContain("Nothing to do");
  });
});

describe("successor-tui account", () => {
  it("reports the stored access and the roster", async () => {
    const dir = await scratchDir();
    await saveCredential({ apiUrl: "http://127.0.0.1:9999", credential: CREDENTIAL, scopes: ["character:list", "play-ticket"], obtainedAt: "2026-07-24T00:00:00.000Z" }, { dir });
    const state = fake();
    expect(await runAccount(ACCOUNT, deps(state, dir))).toBe(0);
    const output = state.lines.join("\n");
    expect(output).toContain("character:list, play-ticket");
    expect(output).toContain("Vex Marrow — scout");
    expect(output).not.toContain(CREDENTIAL);
  });

  it("points at login when nothing is stored", async () => {
    const dir = await scratchDir();
    const state = fake();
    expect(await runAccount(ACCOUNT, deps(state, dir))).toBe(1);
    expect(state.lines.join("\n")).toContain("successor-tui login");
  });
});
