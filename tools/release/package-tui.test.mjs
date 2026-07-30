import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createDeterministicTarGz, packageTuiArtifact, verifyArtifactRow } from "./package-tui.mjs";

const execFile = promisify(execFileCallback);

const SOURCE = { commit: "a".repeat(40), tree: "b".repeat(40) };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "successor-tui-package-"));
  const distDir = path.join(root, "dist");
  const outDir = path.join(root, "out");
  const slicePath = path.join(root, "slice.json");
  await mkdir(path.join(distDir, "chunks"), { recursive: true });
  await writeFile(path.join(distDir, "cli.js"), "console.log('ok');\n", "utf8");
  await writeFile(path.join(distDir, "chunks", "part.js"), "export const part = true;\n", "utf8");
  await writeFile(slicePath, "{\"schema\":\"test.slice\"}\n", "utf8");
  const runtimePath = path.join(root, "node");
  await writeFile(runtimePath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'v22.22.1\\n'; exit 0; fi\nprintf 'runtime=%s\\n' \"$1\"\nprintf 'slice=%s\\n' \"$SUCCESSOR_SLICE_PATH\"\n", "utf8");
  await chmod(runtimePath, 0o755);
  return { root, distDir, outDir, slicePath, runtimePath };
}

async function cleanup(root) { await rm(root, { recursive: true, force: true }); }

test("deterministic tar.gz sorts entries and rejects archive traversal", () => {
  const entries = [{ path: "z.txt", data: Buffer.from("z") }, { path: "a.txt", data: Buffer.from("a") }];
  assert.deepEqual(createDeterministicTarGz(entries), createDeterministicTarGz([...entries].reverse()));
  for (const pathValue of ["../escape", "/absolute", "safe/../escape", "safe\\escape"]) {
    assert.throws(() => createDeterministicTarGz([{ path: pathValue, data: Buffer.from("x") }]), (error) => error?.code === "ARCHIVE_TRAVERSAL");
  }
});

test("refuses symlink escapes in the TUI dist", async () => {
  const value = await fixture();
  try {
    await symlink(path.join(os.tmpdir(), "outside-successor-tui"), path.join(value.distDir, "escape.js"));
    await assert.rejects(packageTuiArtifact({ ...value, platform: "linux", arch: "x64", releaseId: "alpha", version: "0.1.0", source: SOURCE }), (error) => error?.code === "SYMLINK_ESCAPE");
  } finally { await cleanup(value.root); }
});

test("refuses missing chunks and missing runtime", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.distDir, "cli.js"), 'import("./chunks/missing.js");\n', "utf8");
    await assert.rejects(packageTuiArtifact({ ...value, platform: "linux", arch: "x64", releaseId: "alpha", version: "0.1.0", source: SOURCE }), (error) => error?.code === "MISSING_CHUNK");
    await writeFile(path.join(value.distDir, "cli.js"), "console.log('ok');\n", "utf8");
    await assert.rejects(packageTuiArtifact({ ...value, runtimePath: path.join(value.root, "missing-node"), platform: "linux", arch: "x64", releaseId: "alpha", version: "0.1.0", source: SOURCE }), (error) => error?.code === "RUNTIME_MISSING");
  } finally { await cleanup(value.root); }
});

test("refuses unsupported targets before reading build inputs", async () => {
  await assert.rejects(packageTuiArtifact({ distDir: "/does/not/exist", runtimePath: "/does/not/exist", slicePath: "/does/not/exist", platform: "win32", arch: "x64", releaseId: "alpha", version: "0.1.0", source: SOURCE }), (error) => error?.code === "UNSUPPORTED_TARGET");
});

test("emits a runtime-bundled row and detects checksum drift", async () => {
  const value = await fixture();
  try {
    const result = await packageTuiArtifact({ ...value, platform: "linux", arch: "x64", releaseId: "alpha", version: "0.1.0", source: SOURCE });
    assert.equal(result.row.format, "tar.gz");
    assert.equal(result.row.entrypoint, "successor-tui-alpha/bin/successor-tui");
    assert.equal(result.row.runtime, "v22.22.1");
    assert.equal(result.row.publishable, false);
    assert.equal(result.row.source.commit, SOURCE.commit);
    await verifyArtifactRow(result.row, value.outDir);
    await writeFile(result.archivePath, Buffer.concat([await readFile(result.archivePath), Buffer.from("drift")]), "binary");
    await assert.rejects(verifyArtifactRow(result.row, value.outDir), (error) => error?.code === "CHECKSUM_DRIFT");
  } finally { await cleanup(value.root); }
});
test("packages the canonical hosted base@16-hex release identity", async () => {
  const value = await fixture();
  const releaseId = "successor-alpha@731b87bb5ce5ea4c";
  try {
    const result = await packageTuiArtifact({ ...value, platform: "linux", arch: "x64", releaseId, version: "0.1.0", source: SOURCE });
    assert.equal(result.row.releaseId, releaseId);
    assert.equal(result.row.entrypoint, `successor-tui-${releaseId}/bin/successor-tui`);
    await verifyArtifactRow(result.row, value.outDir);
    await assert.rejects(
      packageTuiArtifact({ ...value, platform: "linux", arch: "x64", releaseId: "successor-alpha@short", version: "0.1.0", source: SOURCE }),
      (error) => error?.code === "INVALID_ID",
    );
  } finally { await cleanup(value.root); }
});
test("launcher resolves a relative symlink chain before selecting runtime and dist", async () => {
  const value = await fixture();
  const extractRoot = path.join(value.root, "extract");
  const homeBin = path.join(value.root, "home", "bin");
  try {
    const result = await packageTuiArtifact({ ...value, platform: "linux", arch: "x64", releaseId: "alpha", version: "0.1.0", source: SOURCE });
    await mkdir(extractRoot, { recursive: true });
    await execFile("tar", ["-xzf", result.archivePath, "-C", extractRoot]);
    await mkdir(homeBin, { recursive: true });
    const bundleRoot = path.join(extractRoot, "successor-tui-alpha");
    const launcher = path.join(bundleRoot, "bin", "successor-tui");
    await symlink("successor-tui-target", path.join(homeBin, "successor-tui"));
    await symlink(path.relative(homeBin, launcher), path.join(homeBin, "successor-tui-target"));
    const { stdout } = await execFile(path.join(homeBin, "successor-tui"), ["probe"]);
    assert.match(stdout, /runtime=.*\/successor-tui-alpha\/bin\/\.\.\/dist\/cli\.js/u);
    assert.match(stdout, /slice=.*\/successor-tui-alpha\/bin\/\.\.\/slice\/open-desert-slice\.json/u);
    assert.doesNotMatch(stdout, /\/home\/bin\//u);
  } finally { await cleanup(value.root); }
});
