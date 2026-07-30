import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { aggregateReleaseManifest } from "../scripts/aggregate-release-manifest.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "successor-release-manifest-"));
  const archive = path.join(directory, "successor-linux-x64.tar.gz");
  fs.writeFileSync(archive, "archive bytes\n");
  const row = {
    schemaVersion: 1,
    releaseId: "successor-alpha",
    version: "0.0.1",
    platform: "linux",
    arch: "x64",
    format: "tar.gz",
    bytes: fs.statSync(archive).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    archive: path.basename(archive),
    entrypoint: "run-successor.sh",
    requirements: {
      host: "Linux x64",
      launch: "./run-successor.sh",
      unsigned: true,
      signing: "Not code signed or notarized.",
      gatekeeper: "Not applicable on Linux.",
    },
    sourceCommit: "8e1ed52084cf574cea32a3bbfb26847be82218b6",
  };
  const rowPath = path.join(directory, "successor-linux-x64.json");
  fs.writeFileSync(rowPath, `${JSON.stringify(row, null, 2)}\n`);
  return { directory, archive, row, rowPath };
}

test("release manifest verifies rows and emits deterministic target order", async () => {
  const linux = fixture();
  const mac = fixture();
  mac.row.platform = "darwin";
  mac.row.arch = "arm64";
  mac.row.requirements.host = "macOS arm64";
  mac.row.requirements.gatekeeper = "Unsigned and not notarized; Control-click and choose Open if trusted.";
  mac.rowPath = path.join(mac.directory, "successor-darwin-arm64.json");
  fs.writeFileSync(mac.rowPath, `${JSON.stringify(mac.row, null, 2)}\n`);
  const output = path.join(linux.directory, "manifest.json");

  const manifest = await aggregateReleaseManifest({ outputPath: output, artifactPaths: [mac.rowPath, linux.rowPath] });
  assert.deepEqual(manifest.artifacts.map((artifact) => `${artifact.platform}/${artifact.arch}`), ["darwin/arm64", "linux/x64"]);
  assert.equal(manifest.artifacts.every((artifact) => artifact.bytes > 0 && artifact.sha256.length === 64), true);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).sourceCommit, linux.row.sourceCommit);
});

test("release manifest refuses missing or checksum-mismatched archives", async () => {
  const fixtureData = fixture();
  fixtureData.row.sha256 = "0".repeat(64);
  fs.writeFileSync(fixtureData.rowPath, `${JSON.stringify(fixtureData.row, null, 2)}\n`);
  await assert.rejects(
    aggregateReleaseManifest({ outputPath: path.join(fixtureData.directory, "manifest.json"), artifactPaths: [fixtureData.rowPath] }),
    /checksum mismatch/,
  );
  fs.rmSync(fixtureData.archive);
  await assert.rejects(
    aggregateReleaseManifest({ outputPath: path.join(fixtureData.directory, "manifest.json"), artifactPaths: [fixtureData.rowPath] }),
    /archive is missing/,
  );
});

test("release manifest refuses duplicate target rows", async () => {
  const first = fixture();
  const second = fixture();
  second.rowPath = path.join(second.directory, "duplicate.json");
  fs.writeFileSync(second.rowPath, `${JSON.stringify(second.row, null, 2)}\n`);
  await assert.rejects(
    aggregateReleaseManifest({ outputPath: path.join(first.directory, "manifest.json"), artifactPaths: [first.rowPath, second.rowPath] }),
    /duplicate artifact target row: linux\/x64/,
  );
});
