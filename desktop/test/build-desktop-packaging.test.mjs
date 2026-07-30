import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoDuplicateAudio,
  assertNoSymlinkEscape,
  assertProductionClientDist,
  copyTree,
  prepareElectronRelease,
  resolvePackageMode,
  targetFor,
  walkTarEntries,
  writeTarGz,
} from "../scripts/build-desktop.mjs";

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-package-"));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("hosted-release is deterministic by default and offline-full is explicit", () => {
  assert.equal(resolvePackageMode(), "hosted-release");
  assert.equal(resolvePackageMode("offline-full"), "offline-full");
  assert.throws(() => resolvePackageMode("dev"), /SUCCESSOR_PACKAGE_MODE/);
});

test("hosted-release client surface rejects viewer, source maps, and bulk roots", () => {
  const root = tempDirectory();
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>\n");
  fs.writeFileSync(path.join(root, "production-asset-manifest.json"), "{}\n");
  fs.writeFileSync(path.join(root, "assets", "main.js"), "export {};\n");
  fs.mkdirSync(path.join(root, "successor-audio", "sfx"), { recursive: true });
  assert.doesNotThrow(() => assertProductionClientDist(root));
  fs.writeFileSync(path.join(root, "viewer.html"), "<!doctype html>\n");
  assert.throws(() => assertProductionClientDist(root), /forbidden development surface|unexpected bulk root/);
  fs.rmSync(path.join(root, "viewer.html"));
  fs.writeFileSync(path.join(root, "assets", "main.js.map"), "{}\n");
  assert.throws(() => assertProductionClientDist(root), /forbidden development surface/);
  fs.rmSync(path.join(root, "assets", "main.js.map"));
  fs.mkdirSync(path.join(root, "asset-lab"), { recursive: true });
  fs.writeFileSync(path.join(root, "asset-lab", "index.html"), "<!doctype html>\n");
  assert.throws(() => assertProductionClientDist(root), /unexpected bulk root/);
});

test("desktop package rejects duplicate successor-audio roots", () => {
  const root = tempDirectory();
  fs.mkdirSync(path.join(root, "client", "successor-audio"), { recursive: true });
  fs.mkdirSync(path.join(root, "shared-public", "successor-audio"), { recursive: true });
  assert.throws(() => assertNoDuplicateAudio(root), /duplicate successor-audio/);
});

test("desktop packaging supports only the native alpha targets", () => {
  assert.equal(targetFor("linux", "x64").launcher, "run-successor.sh");
  assert.equal(targetFor("darwin", "arm64").requirements.unsigned, true);
  assert.throws(() => targetFor("darwin", "x64"), /unsupported desktop packaging target/);
});
test("macOS packages use the Successor bundle identity without renaming Electron internals", async () => {
  const root = tempDirectory();
  const electronDist = path.join(root, "electron", "dist");
  const electronApp = path.join(electronDist, "Electron.app");
  const electronContents = path.join(electronApp, "Contents");
  const electronPath = path.join(electronContents, "MacOS", "Electron");
  const appBuildRoot = path.join(root, "app-build");
  const packageRoot = path.join(root, "release", "successor-darwin-arm64");
  const releaseRoot = path.join(root, "release");
  let signedApp;
  fs.mkdirSync(path.dirname(electronPath), { recursive: true });
  fs.mkdirSync(path.join(electronContents, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(electronContents, "Info.plist"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist><dict>",
    "<key>CFBundleDisplayName</key><string>Electron</string>",
    "<key>CFBundleName</key><string>Electron</string>",
    "<key>CFBundleIdentifier</key><string>com.github.electron</string>",
    "<key>CFBundleExecutable</key><string>Electron</string>",
    "</dict></plist>",
    "",
  ].join("\n"));
  fs.writeFileSync(electronPath, "electron\n", { mode: 0o755 });
  fs.mkdirSync(path.join(appBuildRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(appBuildRoot, "src", "main.mjs"), "export {};\n");

  prepareElectronRelease({
    target: targetFor("darwin", "arm64"),
    electronPath,
    appBuildRoot,
    packageRoot,
    releaseRoot,
    signMacApp(appBundle) {
      assert.equal(fs.existsSync(path.join(appBundle, "Contents", "Resources", "app", "src", "main.mjs")), true);
      signedApp = appBundle;
    },
  });

  const successorApp = path.join(packageRoot, "Successor.app");
  const plist = fs.readFileSync(path.join(successorApp, "Contents", "Info.plist"), "utf8");
  assert.equal(fs.existsSync(path.join(packageRoot, "Electron.app")), false);
  assert.equal(fs.existsSync(path.join(successorApp, "Contents", "MacOS", "Electron")), true);
  assert.equal(signedApp, successorApp);
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>Successor<\/string>/u);
  assert.match(plist, /<key>CFBundleName<\/key><string>Successor<\/string>/u);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.lycaon\.successor<\/string>/u);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>Electron<\/string>/u);
  assert.equal(fs.existsSync(path.join(successorApp, "Contents", "Resources", "app", "src", "main.mjs")), true);
  assert.match(fs.readFileSync(path.join(packageRoot, "run-successor.sh"), "utf8"), /Successor\.app\/Contents\/MacOS\/Electron/u);
  const archivePath = path.join(root, "successor-darwin-arm64.tar.gz");
  await writeTarGz(packageRoot, archivePath, "successor-darwin-arm64");
  const archivePaths = walkTarEntries(packageRoot, "successor-darwin-arm64").map((entry) => entry.archivePath);
  assert.equal(archivePaths.some((entry) => entry.startsWith("successor-darwin-arm64/Successor.app/")), true);
  assert.equal(archivePaths.some((entry) => entry.startsWith("successor-darwin-arm64/Electron.app/")), false);
});

test("tar.gz metadata is ordered and deterministic while preserving executable bits", async () => {
  const root = tempDirectory();
  const source = path.join(root, "successor-linux-x64");
  fs.mkdirSync(path.join(source, "nested"), { recursive: true });
  fs.writeFileSync(path.join(source, "nested", "z.txt"), "z\n");
  fs.writeFileSync(path.join(source, "run-successor.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(path.join(source, "run-successor.sh"), 0o755);
  fs.utimesSync(path.join(source, "nested", "z.txt"), new Date(1000), new Date(1000));

  const first = path.join(root, "first.tar.gz");
  const second = path.join(root, "second.tar.gz");
  await writeTarGz(source, first, "successor-linux-x64");
  fs.utimesSync(path.join(source, "nested", "z.txt"), new Date(2000), new Date(2000));
  await writeTarGz(source, second, "successor-linux-x64");

  assert.equal(sha256(first), sha256(second));
  const entries = walkTarEntries(source, "successor-linux-x64");
  assert.deepEqual(entries.map((entry) => entry.archivePath), [
    "successor-linux-x64/",
    "successor-linux-x64/nested/",
    "successor-linux-x64/nested/z.txt",
    "successor-linux-x64/run-successor.sh",
  ]);
  assert.equal(entries.at(-1).stat.mode & 0o111, 0o111);
});

test("packaging rejects symlinks that escape the archive root", () => {
  const root = tempDirectory();
  const source = path.join(root, "package");
  fs.mkdirSync(source);
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "secret\n");
  fs.symlinkSync(outside, path.join(source, "escape"));
  assert.throws(() => assertNoSymlinkEscape(source), /symlink escapes package root/);
});

test("copying the macOS framework preserves internal relative symlinks", () => {
  const root = tempDirectory();
  const source = path.join(root, "source");
  const destination = path.join(root, "package");
  fs.mkdirSync(path.join(source, "Versions", "A"), { recursive: true });
  fs.writeFileSync(path.join(source, "Versions", "A", "Framework"), "binary");
  fs.symlinkSync("A", path.join(source, "Versions", "Current"));
  fs.symlinkSync("Versions/Current/Framework", path.join(source, "Framework"));

  copyTree(source, destination);

  assert.equal(fs.readlinkSync(path.join(destination, "Framework")), "Versions/Current/Framework");
  assert.equal(fs.readlinkSync(path.join(destination, "Versions", "Current")), "A");
  assert.doesNotThrow(() => assertNoSymlinkEscape(destination));
});

test("artifact publishability stays false without hosted auth and without an end-to-end proof", async () => {
  const { artifactPublishability } = await import("../scripts/build-desktop.mjs");
  const absent = artifactPublishability({ hostedAuthBundled: false, hostedProofRecorded: true });
  assert.equal(absent.publishable, false, "hosted-auth absence must keep publishable false even with a proof claim");
  assert.match(absent.distribution, /device-login/);

  const unproven = artifactPublishability({ hostedAuthBundled: true });
  assert.equal(unproven.publishable, false);
  assert.match(unproven.distribution, /end-to-end proof/);

  const proven = artifactPublishability({ hostedAuthBundled: true, hostedProofRecorded: true });
  assert.equal(proven.publishable, true);
});

test("hosted-auth bundling is detected from the packaged app files", async () => {
  const { detectHostedAuthBundled } = await import("../scripts/build-desktop.mjs");
  const root = tempDirectory();
  assert.equal(detectHostedAuthBundled(root), false);
  fs.mkdirSync(path.join(root, "src", "shell"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "hosted-auth.mjs"), "export {};\n");
  fs.writeFileSync(path.join(root, "src", "hosted-session.mjs"), "export {};\n");
  assert.equal(detectHostedAuthBundled(root), false, "missing shell page must read as not bundled");
  fs.writeFileSync(path.join(root, "src", "shell", "connect.html"), "<!doctype html>\n");
  assert.equal(detectHostedAuthBundled(root), true);
});

test("packaging target definitions no longer hardcode publishability", () => {
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"]]) {
    const requirements = targetFor(platform, arch).requirements;
    assert.equal("publishable" in requirements, false, `${platform}/${arch} must compute publishability at build time`);
    assert.equal("distribution" in requirements, false);
  }
});
