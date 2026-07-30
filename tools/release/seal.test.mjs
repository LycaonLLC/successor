import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSealRecords } from "./seal.mjs";
import { buildStagingPromotion } from "./promote-staging.mjs";

const HASH = "a".repeat(64);
const IMAGE = `595529182031.dkr.ecr.us-east-1.amazonaws.com/successor-staging-1/server@sha256:${HASH}`;

function input() {
  const manifest = {
    schema: "successor.source-manifest.v1",
    sourceHash: HASH,
    fileCount: 0,
    totalBytes: 0,
    entries: [],
  };
  const clientManifest = {
    schema: "successor-client-assets.v1",
    release_id: "open-desert-alpha",
    manifest_sha256: HASH,
    files: [{ path: "current.json", sha256: HASH, size: 1 }],
  };
  return {
    source: { commit: "b".repeat(40), tree: "c".repeat(40), sourceHash: HASH, manifest },
    fixture: { identity: "planetfall-v5-open-desert", sliceHash: "d".repeat(64), mapBundleHash: "e".repeat(64) },
    schemas: { wire: "successor.commands.v1", save: "authority.checkpoint.v1@1" },
    authority: { generation: "authority-generation-42", compatibility: "checkpoint-v4-journal-v2", checkpointHash: "f".repeat(64), journalHash: "1".repeat(64) },
    client: { releaseId: clientManifest.release_id, manifestSha256: clientManifest.manifest_sha256, manifest: clientManifest },
    image: { ref: IMAGE, digest: HASH },
    verification: {
      matrix: {
        schema: "successor.verify-matrix.v1",
        runId: "verify-alpha-1",
        status: "pass",
        sourceHash: HASH,
        tasks: [{ id: "node:server", digest: HASH, artifacts: [{ executionAttempt: 0, files: [{ path: "report.json", sha256: HASH, size: 1 }] }] }],
      },
    },
  };
}

describe("release seal records", () => {
  it("binds deterministic source and release identity/content", () => {
    const first = buildSealRecords(input());
    const second = buildSealRecords(input());
    assert.deepEqual(first, second);
    assert.equal(first.sourceSeal.sealSha256.length, 64);
    assert.equal(first.releaseSeal.sealSha256.length, 64);
    assert.equal(first.releaseSeal.sourceSeal.sealSha256, first.sourceSeal.sealSha256);
    assert.equal(first.releaseSeal.verification.runId, "verify-alpha-1");
    const changed = input();
    changed.fixture.sliceHash = "2".repeat(64);
    assert.notEqual(buildSealRecords(changed).sourceSeal.sealSha256, first.sourceSeal.sealSha256);
  });

  it("rejects an unpinned or source-mismatched image and non-passing verification", () => {
    const value = input();
    value.image.ref = "successor:staging";
    assert.throws(() => buildSealRecords(value), (error) => error?.code === "IMAGE_DIGEST_INVALID");
    const failing = input();
    failing.verification.matrix.status = "fail";
    assert.throws(() => buildSealRecords(failing), (error) => error?.code === "VERIFICATION_INVALID");
  });
});

describe("same-digest staging promotion", () => {
  it("promotes the exact tested immutable image and client manifest", () => {
    const releaseSeal = buildSealRecords(input()).releaseSeal;
    const record = buildStagingPromotion({
      releaseSeal,
      testedImageRef: IMAGE,
      candidateImageRef: IMAGE,
      testedClientManifestSha256: HASH,
      candidateClientManifestSha256: HASH,
    });
    assert.equal(record.rebuild, false);
    assert.equal(record.image.ref, IMAGE);
    assert.equal(record.client.manifestSha256, HASH);
  });

  it("refuses digest drift, manifest drift, and rebuild promotion", () => {
    const releaseSeal = buildSealRecords(input()).releaseSeal;
    const otherImage = `${IMAGE.slice(0, -64)}${"2".repeat(64)}`;
    assert.throws(() => buildStagingPromotion({ releaseSeal, testedImageRef: IMAGE, candidateImageRef: otherImage, testedClientManifestSha256: HASH, candidateClientManifestSha256: HASH }), (error) => error?.code === "IMAGE_DIGEST_MISMATCH");
    assert.throws(() => buildStagingPromotion({ releaseSeal, testedImageRef: IMAGE, candidateImageRef: IMAGE, testedClientManifestSha256: HASH, candidateClientManifestSha256: "2".repeat(64) }), (error) => error?.code === "CLIENT_MANIFEST_MISMATCH");
    assert.throws(() => buildStagingPromotion({ releaseSeal, testedImageRef: IMAGE, candidateImageRef: IMAGE, testedClientManifestSha256: HASH, candidateClientManifestSha256: HASH, rebuild: true }), (error) => error?.code === "REBUILD_FORBIDDEN");
  });
});

import { sha256Json } from "../verification/farm/protocol.mjs";

const V2_HASH = "9".repeat(64);
const V2_COMMIT = "8".repeat(40);
const V2_TREE = "7".repeat(40);
const V2_RELEASE = "standalone-alpha-1";
const V2_IMAGE = `registry.example/successor/server@sha256:${V2_HASH}`;

function v2Fixture() {
  const sourceManifest = { schema: "successor.source-manifest.v2", sourceHash: V2_HASH, fileCount: 1, totalBytes: 4, entries: [{ path: "server/src/index.ts", size: 4, sha256: V2_HASH }] };
  const browserManifest = { schema: "successor.browser-assets.v1", releaseId: V2_RELEASE, files: [{ path: "index.js", size: 4, sha256: V2_HASH }] };
  const siteManifest = { schema: "successor.standalone-site-publication.v1", releaseId: V2_RELEASE, releaseDigest: V2_HASH, files: [{ path: "index.html", size: 4, sha256: V2_HASH }] };
  const downloads = { schema: "successor.standalone-download-manifest.v1", releaseId: V2_RELEASE, version: "1.0.0", rows: [
    ["web", "browser", "browser", "web-browser.zip"],
    ["linux", "x64", "desktop", "linux-desktop.zip"],
    ["linux", "x64", "tui", "linux-tui.tar.gz"],
    ["macos", "arm64", "desktop", "macos-desktop.zip"],
    ["macos", "arm64", "tui", "macos-tui.tar.gz"],
  ].map(([platform, arch, client, name]) => ({ platform, arch, client, version: "1.0.0", bytes: 4, sha256: V2_HASH, url: `https://downloads.example/${V2_RELEASE}/1.0.0/${name}`, publishable: true, sourceCommit: V2_COMMIT, proof: { schema: "successor.artifact-proof.v1", status: "pass", bytes: 4, sha256: V2_HASH, sourceCommit: V2_COMMIT } })) };
  const matrix = { schema: "successor.verify-standalone-matrix.v1", runId: "standalone-verify-1", status: "pass", source: { commit: V2_COMMIT, tree: V2_TREE, sourceHash: V2_HASH }, tasks: [{ id: "standalone:server", digest: V2_HASH, sourceCommit: V2_COMMIT, sourceTree: V2_TREE, sourceHash: V2_HASH, artifacts: [{ path: "report.json", bytes: 4, sha256: V2_HASH }] }] };
  return {
    schema: "successor.release-input.v2",
    releaseId: V2_RELEASE,
    source: { commit: V2_COMMIT, tree: V2_TREE, sourceHash: V2_HASH, manifest: sourceManifest, manifestHash: sha256Json(sourceManifest) },
    fixture: { identity: "open-desert-alpha", sliceHash: "6".repeat(64), mapBundleHash: "5".repeat(64) },
    schemas: { wire: "successor.commands.v1", save: "authority.checkpoint.v1@1" },
    controlSchemaHead: { version: 2, name: "alpha-control-bug-reports-v2", checksum: "b42f94dbcc2939109e5fcbb28069ddc215bb2eb8873df522b704aee701994c73" },
    server: { releaseId: V2_RELEASE, image: { ref: V2_IMAGE, digest: V2_HASH } },
    browser: { releaseId: V2_RELEASE, manifest: browserManifest, manifestSha256: sha256Json(browserManifest) },
    site: { releaseId: V2_RELEASE, manifest: siteManifest, manifestSha256: sha256Json(siteManifest), releaseDigest: V2_HASH },
    downloads: { manifest: downloads, manifestSha256: sha256Json(downloads) },
    verification: { matrix, matrixSha256: sha256Json(matrix), artifactIdentity: sha256Json([{ id: "standalone:server", digest: V2_HASH, artifacts: [{ path: "report.json", bytes: 4, sha256: V2_HASH }] }]) },
  };
}

describe("standalone v2 release seal records", () => {
  it("binds the source, all five immutable targets, site, server, and passing matrix", () => {
    const records = buildSealRecords(v2Fixture());
    assert.equal(records.sourceSeal.schema, "successor.release-source-seal.v2");
    assert.equal(records.releaseSeal.schema, "successor.release-seal.v2");
    assert.equal(records.releaseSeal.downloads.rows.length, 5);
    assert.equal(records.releaseSeal.verification.schema, "successor.verify-standalone-matrix.v1");
    assert.equal(records.releaseSeal.sourceSeal.sealSha256, records.sourceSeal.sealSha256);
    assert.deepEqual(records, buildSealRecords(v2Fixture()));
  });

  it("fails closed on target set, publication, URL/ref, schema, digest, and proof drift", () => {
    const cases = [
      ["duplicate target", (input) => { input.downloads.manifest.rows[1] = { ...input.downloads.manifest.rows[0] }; }, "TARGET_DUPLICATE"],
      ["macOS unavailable", (input) => { input.downloads.manifest.rows[4].unavailable = true; }, "TARGET_UNPUBLISHABLE"],
      ["publishable false", (input) => { input.downloads.manifest.rows[0].publishable = false; }, "TARGET_UNPUBLISHABLE"],
      ["manifest artifact drift", (input) => { input.downloads.manifest.rows[0].bytes = 5; }, "TARGET_PROOF_INVALID"],
      ["mutable image ref", (input) => { input.server.image.ref = "registry.example/successor/server:latest"; }, "IMAGE_DIGEST_INVALID"],
      ["credential URL", (input) => { input.downloads.manifest.rows[0].url = `https://user:pass@downloads.example/${V2_RELEASE}/1.0.0/web-browser.zip`; }, "DOWNLOAD_URL_INVALID"],
      ["query URL", (input) => { input.downloads.manifest.rows[0].url += "?token=secret"; }, "DOWNLOAD_URL_INVALID"],
      ["source mismatch", (input) => { input.downloads.manifest.rows[0].sourceCommit = "6".repeat(40); }, "SOURCE_RELEASE_MISMATCH"],
      ["wrong control schema checksum", (input) => { input.controlSchemaHead.checksum = "1".repeat(64); }, "CONTROL_SCHEMA_HEAD_INVALID"],
      ["old verification matrix", (input) => { input.verification.matrix.schema = "successor.verify-matrix.v1"; }, "VERIFICATION_INVALID"],
      ["verification artifact drift", (input) => { input.verification.artifactIdentity = "1".repeat(64); }, "VERIFICATION_ARTIFACT_MISMATCH"],
      ["fake proof flag", (input) => { input.downloads.manifest.rows[0].proof = true; }, "TARGET_PROOF_INVALID"],
    ];
    for (const [name, mutate, code] of cases) {
      const value = v2Fixture();
      mutate(value);
      assert.throws(() => buildSealRecords(value), (error) => error?.code === code, name);
    }
  });
});

it("rejects a download manifest digest drift before publication", () => {
  const value = v2Fixture();
  value.downloads.manifestSha256 = "1".repeat(64);
  assert.throws(() => buildSealRecords(value), (error) => error?.code === "DOWNLOAD_MANIFEST_DIGEST_MISMATCH");
});

it("rejects missing v2 binding fields", () => {
  const cases = [
    ["source commit", (value) => { delete value.source.commit; }, "SOURCE_IDENTITY_INVALID"],
    ["source tree", (value) => { delete value.source.tree; }, "SOURCE_IDENTITY_INVALID"],
    ["source hash", (value) => { delete value.source.sourceHash; }, "SOURCE_IDENTITY_INVALID"],
    ["source manifest", (value) => { delete value.source.manifest; }, "SOURCE_MANIFEST_INVALID"],
    ["fixture slice hash", (value) => { delete value.fixture.sliceHash; }, "FIXTURE_IDENTITY_INVALID"],
    ["fixture map hash", (value) => { delete value.fixture.mapBundleHash; }, "FIXTURE_IDENTITY_INVALID"],
    ["wire schema", (value) => { delete value.schemas.wire; }, "SCHEMA_IDENTITY_INVALID"],
    ["save schema", (value) => { delete value.schemas.save; }, "SCHEMA_IDENTITY_INVALID"],
    ["control schema head", (value) => { delete value.controlSchemaHead; }, "CONTROL_SCHEMA_HEAD_INVALID"],
    ["server release", (value) => { delete value.server.releaseId; }, "SERVER_RELEASE_INVALID"],
    ["image digest", (value) => { delete value.server.image.digest; }, "IMAGE_DIGEST_INVALID"],
    ["browser manifest digest", (value) => { delete value.browser.manifestSha256; }, "CLIENT_MANIFEST_DIGEST_MISMATCH"],
    ["site release digest", (value) => { delete value.site.releaseDigest; delete value.site.manifest.releaseDigest; }, "SITE_RELEASE_DIGEST_INVALID"],
    ["download rows", (value) => { delete value.downloads.manifest.rows; }, "DOWNLOAD_MANIFEST_INVALID"],
    ["verification", (value) => { delete value.verification; }, "VERIFICATION_INVALID"],
  ];
  for (const [name, mutate, code] of cases) {
    const value = v2Fixture();
    mutate(value);
    assert.throws(() => buildSealRecords(value), (error) => error?.code === code, name);
  }
});
