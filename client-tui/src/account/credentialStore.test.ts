import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIAL_FILE,
  CredentialStoreError,
  credentialDir,
  deleteCredential,
  loadCredential,
  saveCredential,
} from "./credentialStore";

const CREDENTIAL = "a".repeat(43);
const VALUE = {
  apiUrl: "https://www.successorgame.com",
  credential: CREDENTIAL,
  scopes: ["character:list", "play-ticket"],
  obtainedAt: "2026-07-24T00:00:00.000Z",
};

let roots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "successor-cred-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("credential store", () => {
  it("stores atomically with 0700 directory and 0600 file, then loads it back", async () => {
    const dir = path.join(await scratchRoot(), "state", "successor");
    const file = await saveCredential(VALUE, { dir });

    const dirStat = await stat(dir);
    const fileStat = await stat(file);
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
    // exclusive temp + rename left nothing behind
    expect((await readdir(dir)).sort()).toEqual([CREDENTIAL_FILE]);

    const loaded = await loadCredential({ dir });
    expect(loaded).not.toBeNull();
    expect(loaded!.credential).toBe(CREDENTIAL);
    expect(loaded!.scopes).toEqual(["character:list", "play-ticket"]);
    expect(loaded!.apiUrl).toBe(VALUE.apiUrl);
  });

  it("returns null when nothing is stored", async () => {
    const root = await scratchRoot();
    expect(await loadCredential({ dir: path.join(root, "never-created") })).toBeNull();
    const dir = path.join(root, "empty");
    await mkdir(dir, { mode: 0o700, recursive: true });
    expect(await loadCredential({ dir })).toBeNull();
  });

  it("rejects a symlinked credential file", async () => {
    const root = await scratchRoot();
    const dir = path.join(root, "successor");
    await mkdir(dir, { mode: 0o700 });
    const target = path.join(root, "elsewhere.json");
    await writeFile(target, JSON.stringify({}), { mode: 0o600 });
    await symlink(target, path.join(dir, CREDENTIAL_FILE));
    await expect(loadCredential({ dir })).rejects.toMatchObject({ code: "CREDENTIAL_FILE_SYMLINK" });
  });

  it("rejects a symlinked credential directory", async () => {
    const root = await scratchRoot();
    const real = path.join(root, "real");
    await mkdir(real, { mode: 0o700 });
    const link = path.join(root, "link");
    await symlink(real, link);
    await expect(loadCredential({ dir: link })).rejects.toMatchObject({ code: "CREDENTIAL_DIR_SYMLINK" });
    await expect(saveCredential(VALUE, { dir: link })).rejects.toMatchObject({ code: "CREDENTIAL_DIR_SYMLINK" });
  });

  it("rejects wrong ownership", async () => {
    const dir = path.join(await scratchRoot(), "successor");
    await saveCredential(VALUE, { dir });
    const notMe = (process.getuid?.() ?? 0) + 1;
    await expect(loadCredential({ dir, uid: notMe })).rejects.toMatchObject({ code: "CREDENTIAL_DIR_WRONG_OWNER" });
  });

  it("rejects a group/world-accessible directory and file", async () => {
    const dir = path.join(await scratchRoot(), "successor");
    await saveCredential(VALUE, { dir });
    await chmod(dir, 0o750);
    await expect(loadCredential({ dir })).rejects.toMatchObject({ code: "CREDENTIAL_DIR_PERMISSIVE" });
    await expect(saveCredential(VALUE, { dir })).rejects.toMatchObject({ code: "CREDENTIAL_DIR_PERMISSIVE" });
    await chmod(dir, 0o700);
    await chmod(path.join(dir, CREDENTIAL_FILE), 0o640);
    await expect(loadCredential({ dir })).rejects.toMatchObject({ code: "CREDENTIAL_FILE_PERMISSIVE" });
  });

  it("rejects malformed contents and refuses to store a malformed token", async () => {
    const dir = path.join(await scratchRoot(), "successor");
    await saveCredential(VALUE, { dir });
    const file = path.join(dir, CREDENTIAL_FILE);

    await writeFile(file, "not json", { mode: 0o600 });
    await expect(loadCredential({ dir })).rejects.toMatchObject({ code: "CREDENTIAL_MALFORMED" });

    await writeFile(file, JSON.stringify({ ...VALUE, schema: "successor.tui-credential.v1", credential: "short" }), { mode: 0o600 });
    await expect(loadCredential({ dir })).rejects.toMatchObject({ code: "CREDENTIAL_MALFORMED" });

    await writeFile(file, JSON.stringify({ ...VALUE, schema: "successor.tui-credential.v1", extra: true }), { mode: 0o600 });
    await expect(loadCredential({ dir })).rejects.toMatchObject({ code: "CREDENTIAL_MALFORMED" });

    await writeFile(file, JSON.stringify({ ...VALUE, schema: "successor.tui-credential.v1", scopes: ["root"] }), { mode: 0o600 });
    await expect(loadCredential({ dir })).rejects.toMatchObject({ code: "CREDENTIAL_MALFORMED" });

    await expect(saveCredential({ ...VALUE, credential: "ticket with spaces" }, { dir })).rejects.toMatchObject({ code: "CREDENTIAL_MALFORMED" });
  });

  it("replaces an existing credential atomically", async () => {
    const dir = path.join(await scratchRoot(), "successor");
    await saveCredential(VALUE, { dir });
    const replacement = "b".repeat(43);
    await saveCredential({ ...VALUE, credential: replacement }, { dir });
    const loaded = await loadCredential({ dir });
    expect(loaded!.credential).toBe(replacement);
    expect((await readdir(dir)).sort()).toEqual([CREDENTIAL_FILE]);
  });

  it("deletes exactly once", async () => {
    const dir = path.join(await scratchRoot(), "successor");
    await saveCredential(VALUE, { dir });
    expect(await deleteCredential({ dir })).toBe(true);
    expect(await deleteCredential({ dir })).toBe(false);
    expect(await loadCredential({ dir })).toBeNull();
  });

  it("derives the default directory from XDG state home", () => {
    expect(credentialDir({ XDG_STATE_HOME: "/tmp/xdg-state" })).toBe("/tmp/xdg-state/successor");
    expect(credentialDir({})).toBe(path.join(os.homedir(), ".local", "state", "successor"));
    // relative XDG values are ignored per the spec
    expect(credentialDir({ XDG_STATE_HOME: "relative/state" })).toBe(path.join(os.homedir(), ".local", "state", "successor"));
  });

  it("carries typed codes on refusals", async () => {
    const dir = path.join(await scratchRoot(), "successor");
    await saveCredential(VALUE, { dir });
    await chmod(dir, 0o755);
    const failure = await loadCredential({ dir }).catch((error) => error as CredentialStoreError);
    expect(failure).toBeInstanceOf(CredentialStoreError);
    expect((failure as CredentialStoreError).message).toContain("chmod 700");
  });
});
