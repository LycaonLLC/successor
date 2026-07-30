import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEvidenceWriter } from "./evidence.mjs";

const SHA = "f07c47d00ee804c88662576a4ed6ca69cadf432f";

async function withEvidence(name, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `successor-rc-${name}-`));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("clean evidence seals with the strict stack shape", () => withEvidence("clean", async (root) => {
  const writer = createEvidenceWriter({ artifactRoot: root, runId: "rc-clean", sha: SHA });
  await writer.init();
  await writer.record({ type: "gate.pass", atMs: 4, gate: "worldReady" });
  const result = await writer.seal({
    verdict: "pass",
    stack: {
      siteUrl: "https://127.0.0.1:41001",
      clientUrl: "https://127.0.0.1:41002",
      controlUrl: "http://127.0.0.1:41003",
      releaseId: "successor-rc@f07c47d00ee804c",
    },
    steps: [{ name: "world", status: "pass" }],
  });
  assert.equal(result.ok, true);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.verdict, "pass");
  assert.match(manifest.sealed.manifestSha256, /^[0-9a-f]{64}$/u);
  const schema = JSON.parse(await fs.readFile(new URL("./evidence.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(schema.properties.stack.properties).sort(), ["clientUrl", "controlUrl", "releaseId", "siteUrl", "status"]);
  assert.deepEqual(Object.keys(schema.properties.failure.properties).sort(), ["code", "reason", "step"]);
}));

test("forbidden evidence fields fail before persistence", () => withEvidence("field", async (root) => {
  const writer = createEvidenceWriter({ artifactRoot: root, runId: "rc-field", sha: SHA });
  await writer.init();
  await assert.rejects(writer.record({ type: "bad", password: "not-written" }), /forbidden evidence field/u);
  await assert.rejects(writer.record({ type: "bad", playerId: "not-written" }), /forbidden evidence field/u);
  await assert.rejects(writer.record({ type: "bad", meta: { deviceCredential: "not-written" } }), /forbidden evidence field/u);
  assert.equal(await fs.readFile(path.join(root, "events.jsonl"), "utf8"), "");
}));

test("aliases reject secret-bearing field families even with unregistered values", async () => {
  for (const field of ["ticket", "authorization", "cookie", "csrf", "password", "capability"]) {
    await withEvidence(`alias-${field}`, async (root) => {
      const writer = createEvidenceWriter({ artifactRoot: root, runId: "rc-alias", sha: SHA });
      await writer.init();
      await assert.rejects(
        writer.seal({ verdict: "pass", aliases: { [field]: "unregistered-value" }, steps: [{ name: "safe", status: "pass" }] }),
        new RegExp(`forbidden evidence field: ${field}`),
      );
      assert.equal(await fs.access(path.join(root, "manifest.json")).then(() => true, () => false), false);
    });
  }
});

test("manifest sealing refuses a symlink without changing its target", () => withEvidence("manifest-symlink", async (root) => {
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
  try {
    await fs.writeFile(outside, "sentinel", { encoding: "utf8", mode: 0o600 });
    const writer = createEvidenceWriter({ artifactRoot: root, runId: "rc-manifest-symlink", sha: SHA });
    await writer.init();
    await fs.symlink(outside, path.join(root, "manifest.json"));
    await assert.rejects(writer.seal({ verdict: "fail", steps: [{ name: "unsafe", status: "fail" }] }), /ELOOP|symbolic link/iu);
    assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
  } finally {
    await fs.rm(outside, { force: true });
  }
}));

test("normal p1 and p2 aliases remain in sealed evidence", () => withEvidence("aliases", async (root) => {
  const writer = createEvidenceWriter({ artifactRoot: root, runId: "rc-aliases", sha: SHA });
  await writer.init();
  const result = await writer.seal({ verdict: "pass", aliases: { p1: "p1", p2: "p2" }, steps: [{ name: "safe", status: "pass" }] });
  assert.equal(result.ok, true);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.aliases, { p1: "p1", p2: "p2" });
}));

test("a minted secret quarantines every evidence artifact", () => withEvidence("secret", async (root) => {
  const secret = "proof-only-secret-7a91f821";
  const writer = createEvidenceWriter({ artifactRoot: root, runId: "rc-secret", sha: SHA, secrets: [secret] });
  await writer.init();
  await writer.record({ type: "bad", detail: secret });
  const result = await writer.seal({ verdict: "fail", steps: [{ name: "secret", status: "fail" }] });
  assert.equal(result.ok, false);
  assert.equal(result.scan.code, "minted-secret-present");
  assert.deepEqual(await fs.readdir(root), ["tombstone.json"]);
}));

test("evidence writes and screenshots cannot escape through paths", () => withEvidence("paths", async (root) => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "successor-rc-outside-"));
  try {
    const writer = createEvidenceWriter({ artifactRoot: root, runId: "rc-paths", sha: SHA });
    await writer.init();
    await fs.symlink(outside, path.join(root, "escape"));
    await assert.rejects(writer.writeJson("escape/leak.json", { safe: true }), /symlink in evidence path/u);
    await assert.rejects(writer.seal({ verdict: "fail", screenshots: ["/etc/passwd"], steps: [{ name: "path", status: "fail" }] }), /invalid screenshot evidence path/u);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
}));
