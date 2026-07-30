import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canPersistCredential, createCredentialStore, credentialFilePath } from "../src/credential-store.mjs";

const CREDENTIAL = "credential-0123456789abcdef0123";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "successor-credential-store-"));
}

function hostileSafeStorage() {
  return new Proxy({}, {
    get() {
      throw new Error("safeStorage must never be touched");
    },
  });
}

function storeFor(dir, platform = process.platform) {
  return createCredentialStore({ userDataDir: dir, platform, safeStorage: hostileSafeStorage() });
}

test("persistence is POSIX-only and does not inspect safeStorage", () => {
  assert.equal(canPersistCredential("win32"), false);
  assert.equal(canPersistCredential("linux"), true);
  assert.equal(canPersistCredential("darwin"), true);
});

test("non-POSIX is memory-only and writes nothing", async () => {
  const dir = tempDir();
  const store = storeFor(dir, "win32");
  assert.equal(store.persistAvailable(), false);
  assert.deepEqual(await store.save(CREDENTIAL), { persisted: false, reason: "memory-only" });
  assert.equal(await store.load(), null);
  assert.deepEqual(await store.clear(), { cleared: false, reason: "unsafe-storage" });
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("save/load/clear uses an owner-only v2 token file and atomic temp", async () => {
  const dir = tempDir();
  const store = storeFor(dir, process.platform);
  const saved = await store.save(CREDENTIAL);
  assert.equal(saved.persisted, true);
  const filePath = credentialFilePath(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const raw = fs.readFileSync(filePath, "utf8");
  assert.deepEqual(JSON.parse(raw), { v: 2, token: CREDENTIAL });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
  assert.equal(await store.load(), CREDENTIAL);
  assert.deepEqual(await store.clear(), { cleared: true });
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(await store.load(), null);
});

test("v1 ciphertext is ignored and left untouched", async () => {
  const dir = tempDir();
  const oldPath = path.join(dir, "hosted-device-credential.v1.json");
  const oldPayload = `${JSON.stringify({ v: 1, cipher: "not-for-decryption" })}\n`;
  fs.writeFileSync(oldPath, oldPayload, { mode: 0o600 });
  const store = storeFor(dir, process.platform);
  assert.equal(await store.load(), null);
  assert.equal(fs.readFileSync(oldPath, "utf8"), oldPayload);
  assert.equal(fs.existsSync(credentialFilePath(dir)), false);
});

test("malformed, oversized, wrong-mode, and symlink files reject without repair", async () => {
  const dir = tempDir();
  const store = storeFor(dir, process.platform);
  const filePath = credentialFilePath(dir);

  fs.writeFileSync(filePath, "not json at all", { mode: 0o600 });
  assert.equal(await store.load(), null);
  assert.equal(fs.existsSync(filePath), true);
  fs.writeFileSync(filePath, JSON.stringify({ v: 2, token: "too-short" }), { mode: 0o600 });
  assert.equal(await store.load(), null);
  fs.chmodSync(filePath, 0o644);
  assert.equal(await store.load(), null);
  assert.deepEqual(await store.save(CREDENTIAL), { persisted: false, reason: "unsafe-storage" });
  fs.unlinkSync(filePath);

  const outside = path.join(dir, "outside-token");
  fs.writeFileSync(outside, JSON.stringify({ v: 2, token: CREDENTIAL }), { mode: 0o600 });
  fs.symlinkSync(outside, filePath);
  assert.equal(await store.load(), null);
  assert.deepEqual(await store.save(CREDENTIAL), { persisted: false, reason: "unsafe-storage" });
  assert.deepEqual(await store.clear(), { cleared: false, reason: "unsafe-storage" });
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.readFileSync(outside, "utf8").includes(CREDENTIAL), true);
});

test("unsafe owner directory is refused rather than chmod-repaired", async () => {
  const dir = tempDir();
  fs.chmodSync(dir, 0o755);
  const store = storeFor(dir, process.platform);
  assert.deepEqual(await store.save(CREDENTIAL), { persisted: false, reason: "unsafe-storage" });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
});
