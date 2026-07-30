#!/usr/bin/env node
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const clientRoot = path.join(repoRoot, "client-3d");
const clientDist = path.join(clientRoot, "dist");
const sharedPublicRoot = path.join(repoRoot, "client", "public");
const bundledSharedPublicSubdirs = ["successor-audio"];
const PACKAGE_MODE_HOSTED_RELEASE = "hosted-release";
const PACKAGE_MODE_OFFLINE_FULL = "offline-full";
const DEFAULT_HOSTED_RELEASE_ARCHIVE_BUDGET_BYTES = 400 * 1024 * 1024;
const PRODUCTION_ALLOWED_ROOTS = new Set([
  "assets",
  "current.json",
  "index.html",
  "production-asset-manifest.json",
  "successor-audio",
  "successor-slice",
]);
const PRODUCTION_FORBIDDEN_PATH = /(?:^|\/)(?:action[-_]browser|asset[-_]lab|debug(?:[-_]|\/|\.html)|fx[-_]lab|trade[-_]smoke|viewer(?:\.html)?)(?:$|\/)|\.map$/iu;
const buildRoot = path.join(desktopRoot, "dist");
const appBuildRoot = path.join(buildRoot, "app");
const releaseRoot = path.join(desktopRoot, "release");
const packageVersion = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8")).version;

const targetDefinitions = {
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    launcher: "run-successor.sh",
    requirements: {
      host: "Linux x64",
      launch: "./run-successor.sh",
      unsigned: true,
      signing: "Not code signed or notarized.",
      gatekeeper: "Not applicable on Linux.",
    },
  },
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    launcher: "run-successor.sh",
    requirements: {
      host: "macOS arm64",
      launch: "./run-successor.sh",
      unsigned: true,
      signing: "Ad-hoc signed for local execution; not Developer ID signed or notarized.",
      gatekeeper: "This alpha is ad-hoc signed but not notarized. If macOS blocks launch, Control-click Successor.app, choose Open, and continue only if you trust this artifact.",
    },
  },
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function main() {
  const target = targetFor(process.platform, process.arch);
  const { default: electronPath } = await import("electron");
  const result = await buildDesktop({
    target,
    electronPath,
    sourceRoot: repoRoot,
    desktopRoot,
    clientDist,
    sharedPublicRoot,
    appBuildRoot,
    releaseRoot,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function buildDesktop({
  target,
  electronPath,
  sourceRoot,
  desktopRoot: root,
  clientDist: distPath,
  sharedPublicRoot: sharedRoot,
  appBuildRoot: appRoot,
  releaseRoot: releases,
  hostedProofRecorded = false,
  packageMode = resolvePackageMode(),
}) {
  assertTargetMatchesHost(target);
  const resolvedPackageMode = resolvePackageMode(packageMode);
  if (resolvedPackageMode === PACKAGE_MODE_HOSTED_RELEASE) assertProductionClientDist(distPath);
  assertFile(path.join(distPath, "index.html"), "client-3d production build missing; run pnpm --dir client-3d build before packaging");
  assertFile(electronPath, "electron binary missing; run pnpm install");

  const packageName = `successor-${target.platform}-${target.arch}`;
  const packageRoot = path.join(releases, packageName);
  const archivePath = path.join(releases, `${packageName}.tar.gz`);
  const artifactRecordPath = path.join(releases, `${packageName}.json`);
  const releaseId = process.env.SUCCESSOR_RELEASE_ID || "successor-alpha";
  const version = process.env.SUCCESSOR_RELEASE_VERSION || packageVersion;
  const source = sourceIdentity(sourceRoot);
  const sizeBudgetBytes = packageSizeBudget(resolvedPackageMode);

  prepareAppBundle({
    desktopRoot: root,
    appBuildRoot: appRoot,
    clientDist: distPath,
    sharedPublicRoot: sharedRoot,
    packageMode: resolvedPackageMode,
  });
  prepareElectronRelease({ target, electronPath, appBuildRoot: appRoot, packageRoot, releaseRoot: releases });
  const publishability = artifactPublishability({
    hostedAuthBundled: detectHostedAuthBundled(appRoot),
    hostedProofRecorded,
  });
  assertNoSymlinkEscape(packageRoot);
  await writeTarGz(packageRoot, archivePath, packageName);

  const archiveStat = fs.statSync(archivePath);
  if (sizeBudgetBytes !== null && archiveStat.size > sizeBudgetBytes) {
    throw new Error(`desktop ${resolvedPackageMode} archive exceeds size budget: ${archiveStat.size} > ${sizeBudgetBytes} bytes`);
  }
  const assetManifest = readPackagedAssetManifest(appRoot);
  const artifact = {
    schemaVersion: 2,
    releaseId,
    version,
    mode: resolvedPackageMode,
    platform: target.platform,
    arch: target.arch,
    format: "tar.gz",
    bytes: archiveStat.size,
    budget: {
      maxBytes: sizeBudgetBytes,
      withinBudget: sizeBudgetBytes === null || archiveStat.size <= sizeBudgetBytes,
    },
    sha256: await sha256File(archivePath),
    archive: path.basename(archivePath),
    entrypoint: target.launcher,
    requirements: { ...target.requirements, ...publishability },
    source: {
      commit: source.commit,
      clean: source.clean,
      clientDist: toPosix(path.relative(sourceRoot, distPath)),
      assetManifest: assetManifest
        ? { contentHash: assetManifest.contentHash ?? null, manifestSha256: assetManifest.manifestSha256 ?? null }
        : null,
    },
    sourceCommit: source.commit,
  };
  fs.writeFileSync(artifactRecordPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644 });

  return {
    ok: true,
    packageRoot,
    archivePath,
    artifactRecordPath,
    entrypoint: path.join(packageRoot, target.launcher),
    artifact,
  };
}

function targetFor(platform, arch) {
  const target = targetDefinitions[`${platform}-${arch}`];
  if (!target) throw new Error(`unsupported desktop packaging target: ${platform}/${arch}; supported targets: linux/x64 and darwin/arm64`);
  return target;
}

function assertTargetMatchesHost(target) {
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(`desktop packaging must run natively for ${target.platform}/${target.arch}; got ${process.platform}/${process.arch}`);
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
}

function copyTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

function prepareAppBundle({
  desktopRoot: root,
  appBuildRoot: appRoot,
  clientDist: distPath,
  sharedPublicRoot: sharedRoot,
  packageMode,
}) {
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.mkdirSync(appRoot, { recursive: true });
  copyTree(path.join(root, "src"), path.join(appRoot, "src"));
  copyTree(distPath, path.join(appRoot, "client"));
  copyBundledSharedPublicAssets(appRoot, sharedRoot, distPath);
  assertNoDuplicateAudio(appRoot);
  if (packageMode === PACKAGE_MODE_HOSTED_RELEASE) assertPackagedProductionSurface(appRoot);
  fs.writeFileSync(path.join(appRoot, "package.json"), `${JSON.stringify({
    name: "successor-desktop-app",
    version: packageVersion,
    private: true,
    type: "module",
    main: "src/main.mjs",
    successorPackageMode: packageMode,
    successorClientReleaseId: process.env.SUCCESSOR_CLIENT_RELEASE_ID || "successor-alpha",
  }, null, 2)}\n`);
}

function copyBundledSharedPublicAssets(appRoot, sharedRoot, clientDist) {
  const sharedPublicBuildRoot = path.join(appRoot, "shared-public");
  for (const name of bundledSharedPublicSubdirs) {
    if (directoryExists(path.join(clientDist, name))) continue;
    const source = path.join(sharedRoot, name);
    if (!directoryExists(source)) continue;
    fs.mkdirSync(sharedPublicBuildRoot, { recursive: true });
    copyTree(source, path.join(sharedPublicBuildRoot, name));
  }
}

function assertProductionClientDist(distPath) {
  assertFile(path.join(distPath, "production-asset-manifest.json"), "hosted-release packaging requires the generated production asset manifest");
  for (const relativePath of walkRelativeFiles(distPath)) {
    const rootName = relativePath.split("/")[0];
    if (!PRODUCTION_ALLOWED_ROOTS.has(rootName)) {
      throw new Error(`production client contains unexpected bulk root: ${rootName}`);
    }
    if (PRODUCTION_FORBIDDEN_PATH.test(relativePath)) {
      throw new Error(`production client contains forbidden development surface: ${relativePath}`);
    }
  }
}

function assertPackagedProductionSurface(appRoot) {
  assertProductionClientDist(path.join(appRoot, "client"));
  for (const relativePath of walkRelativeFiles(path.join(appRoot, "client"))) {
    if (PRODUCTION_FORBIDDEN_PATH.test(relativePath)) {
      throw new Error(`hosted-release package contains forbidden development surface: client/${relativePath}`);
    }
  }
}

function assertNoDuplicateAudio(appRoot) {
  const clientAudio = directoryExists(path.join(appRoot, "client", "successor-audio"));
  const sharedAudio = directoryExists(path.join(appRoot, "shared-public", "successor-audio"));
  if (clientAudio && sharedAudio) {
    throw new Error("desktop package contains duplicate successor-audio roots");
  }
}

function walkRelativeFiles(root) {
  const files = [];
  visit(path.resolve(root), "");
  return files;

  function visit(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
      else throw new Error(`production client contains unsupported filesystem entry: ${relative}`);
    }
  }
}

function readPackagedAssetManifest(appRoot) {
  const manifestPath = path.join(appRoot, "client", "production-asset-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`packaged production asset manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolvePackageMode(raw = process.env.SUCCESSOR_PACKAGE_MODE) {
  if (raw === undefined || raw === "") return PACKAGE_MODE_HOSTED_RELEASE;
  if (raw === PACKAGE_MODE_HOSTED_RELEASE || raw === PACKAGE_MODE_OFFLINE_FULL) return raw;
  throw new Error(`SUCCESSOR_PACKAGE_MODE must be "${PACKAGE_MODE_HOSTED_RELEASE}" or "${PACKAGE_MODE_OFFLINE_FULL}"; got "${raw}"`);
}

function packageSizeBudget(mode) {
  const raw = process.env.SUCCESSOR_PACKAGE_MAX_BYTES;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`SUCCESSOR_PACKAGE_MAX_BYTES must be a positive integer; got "${raw}"`);
    }
    return parsed;
  }
  return mode === PACKAGE_MODE_HOSTED_RELEASE ? DEFAULT_HOSTED_RELEASE_ARCHIVE_BUDGET_BYTES : null;
}

function prepareElectronRelease({ target, electronPath, appBuildRoot, packageRoot, releaseRoot: releases, signMacApp = process.platform === "darwin" ? signMacAppBundle : () => {} }) {
  const electronDist = electronDistributionRoot(electronPath, target.platform);
  assertFile(target.platform === "darwin" ? electronPath : path.join(electronDist, path.basename(electronPath)), "electron distribution is incomplete; run pnpm install");
  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.mkdirSync(releases, { recursive: true });
  copyTree(electronDist, packageRoot);

  const appBundle = target.platform === "darwin" ? path.join(packageRoot, "Successor.app") : null;
  if (target.platform === "darwin") {
    const electronApp = path.join(packageRoot, "Electron.app");
    assertFile(path.join(electronApp, "Contents", "Info.plist"), "electron distribution is missing Electron.app/Contents/Info.plist");
    fs.renameSync(electronApp, appBundle);
    configureMacAppBundle(appBundle);
  }
  const resourcesDir = target.platform === "darwin"
    ? path.join(appBundle, "Contents", "Resources")
    : path.join(packageRoot, "resources");
  fs.rmSync(path.join(resourcesDir, "app"), { recursive: true, force: true });
  copyTree(appBuildRoot, path.join(resourcesDir, "app"));

  const packagedBinary = target.platform === "darwin"
    ? path.join(appBundle, "Contents", "MacOS", path.basename(electronPath))
    : path.join(packageRoot, "successor");
  if (target.platform !== "darwin") {
    const originalBinary = path.join(packageRoot, path.basename(electronPath));
    if (originalBinary !== packagedBinary) {
      fs.rmSync(packagedBinary, { force: true });
      fs.renameSync(originalBinary, packagedBinary);
    }
  }
  fs.chmodSync(packagedBinary, 0o755);
  if (target.platform === "darwin") signMacApp(appBundle);
  writeLauncherScript(packageRoot, packagedBinary, target.platform);
  if (target.platform === "linux") writeDesktopFile(packageRoot);
}

const MACOS_BUNDLE_DISPLAY_NAME = "Successor";
const MACOS_BUNDLE_IDENTIFIER = "com.lycaon.successor";

function configureMacAppBundle(appBundle) {
  const plistPath = path.join(appBundle, "Contents", "Info.plist");
  let plist = fs.readFileSync(plistPath, "utf8");
  for (const [key, value] of [
    ["CFBundleDisplayName", MACOS_BUNDLE_DISPLAY_NAME],
    ["CFBundleName", MACOS_BUNDLE_DISPLAY_NAME],
    ["CFBundleIdentifier", MACOS_BUNDLE_IDENTIFIER],
  ]) {
    const keyPattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, "u");
    if (!keyPattern.test(plist)) throw new Error(`Electron Info.plist is missing ${key}`);
    plist = plist.replace(keyPattern, `$1${value}$2`);
  }
  fs.writeFileSync(plistPath, plist, "utf8");
}

function signMacAppBundle(appBundle) {
  const result = childProcess.spawnSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", appBundle],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "codesign failed").trim();
    throw new Error(`could not ad-hoc sign Successor.app: ${detail}`);
  }
}

function electronDistributionRoot(electronPath, platform) {
  if (platform === "darwin") return path.resolve(path.dirname(electronPath), "../../..");
  return path.dirname(electronPath);
}

function writeLauncherScript(root, packagedBinary, platform) {
  const launcherPath = path.join(root, "run-successor.sh");
  const relativeBinary = path.relative(root, packagedBinary).split(path.sep).join("/");
  const gatekeeperNote = platform === "darwin"
    ? "# This alpha is ad-hoc signed but not notarized; macOS may require Control-click > Open.\n"
    : "";
  fs.writeFileSync(launcherPath, `#!/usr/bin/env sh\nset -eu\n${gatekeeperNote}HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/${relativeBinary}" "$@"\n`);
  fs.chmodSync(launcherPath, 0o755);
}

function writeDesktopFile(root) {
  const desktopFilePath = path.join(root, "successor.desktop");
  fs.writeFileSync(desktopFilePath, [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Successor",
    "Comment=Successor desktop client",
    "Exec=./run-successor.sh",
    "Terminal=false",
    "Categories=Game;",
    "StartupWMClass=Successor",
    "",
  ].join("\n"));
}

function assertNoSymlinkEscape(root) {
  const realRoot = fs.realpathSync(root);
  visit(root);

  function visit(current) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      let resolved;
      try {
        resolved = fs.realpathSync(current);
      } catch (error) {
        throw new Error(`package contains dangling symlink: ${path.relative(root, current)} (${error.message})`);
      }
      if (!isWithin(realRoot, resolved)) {
        throw new Error(`package symlink escapes package root: ${path.relative(root, current)} -> ${fs.readlinkSync(current)}`);
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`package contains unsupported filesystem entry: ${path.relative(root, current)}`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function directoryExists(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function assertFile(filePath, message) {
  try {
    if (fs.statSync(filePath).isFile()) return;
  } catch {
    // fall through
  }
  throw new Error(message);
}

function sourceIdentity(sourceRoot) {
  const commit = sourceCommit(sourceRoot);
  const status = childProcess.spawnSync(
    "git",
    ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  if (status.status !== 0) throw new Error(`unable to inspect source tree: ${status.stderr || "git status failed"}`);
  if (status.stdout.trim() !== "") {
    throw new Error("desktop packaging requires a clean source tree; commit or remove source changes before packaging");
  }
  return { commit, clean: true };
}

function sourceCommit(sourceRoot) {
  const result = childProcess.spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`unable to identify source commit: ${result.stderr || "git rev-parse failed"}`);
  return result.stdout.trim();
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function writeTarGz(sourceDir, destination, rootName) {
  fs.rmSync(destination, { force: true });
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const output = fs.createWriteStream(destination, { mode: 0o644 });
  const gzip = zlib.createGzip({ level: 9, mtime: 0 });
  gzip.pipe(output);

  for (const entry of walkTarEntries(sourceDir, rootName)) {
    const paxPayload = paxPayloadFor(entry);
    if (paxPayload) {
      const paxEntry = paxHeaderEntry(entry, paxPayload);
      gzip.write(tarHeader(paxEntry));
      gzip.write(paxPayload);
      padTarEntry(gzip, paxPayload.length);
    }

    const headerEntry = paxPayload ? safeHeaderEntry(entry) : entry;
    gzip.write(tarHeader(headerEntry));
    if (entry.type === "file") {
      await writeFileToStream(entry.absolutePath, gzip);
      padTarEntry(gzip, entry.size);
    }
  }
  gzip.write(Buffer.alloc(1024));
  gzip.end();
  await onceFinished(output);
}

function walkTarEntries(sourceDir, rootName) {
  const entries = [];
  visit(sourceDir, rootName);
  return entries;

  function visit(absolutePath, archivePath) {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) {
      entries.push({ type: "directory", absolutePath, archivePath: withTrailingSlash(toPosix(archivePath)), stat, size: 0 });
      for (const name of fs.readdirSync(absolutePath).sort()) visit(path.join(absolutePath, name), `${archivePath}/${name}`);
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ type: "symlink", absolutePath, archivePath: toPosix(archivePath), stat, size: 0, linkName: fs.readlinkSync(absolutePath) });
      return;
    }
    if (stat.isFile()) {
      entries.push({ type: "file", absolutePath, archivePath: toPosix(archivePath), stat, size: stat.size });
      return;
    }
    throw new Error(`cannot archive unsupported filesystem entry: ${absolutePath}`);
  }
}

function tarHeader(entry) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(entry.archivePath);
  writeString(header, name, 0, 100);
  writeOctal(header, entry.stat.mode & 0o7777, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, entry.size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = tarTypeFlag(entry);
  if (entry.type === "symlink") writeString(header, entry.linkName, 157, 100);
  writeString(header, "ustar", 257, 6);
  writeString(header, "00", 263, 2);
  writeString(header, "", 265, 32);
  writeString(header, "", 297, 32);
  writeString(header, prefix, 345, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeChecksum(header, checksum);
  return header;
}

function tarTypeFlag(entry) {
  if (entry.type === "directory") return 0x35;
  if (entry.type === "symlink") return 0x32;
  if (entry.type === "pax") return 0x78;
  return 0x30;
}

function paxPayloadFor(entry) {
  const records = [];
  if (requiresPaxPath(entry.archivePath)) records.push(paxRecord("path", entry.archivePath));
  if (entry.type === "symlink" && requiresPaxPath(entry.linkName)) records.push(paxRecord("linkpath", entry.linkName));
  return records.length > 0 ? Buffer.from(records.join("")) : null;
}

function paxHeaderEntry(entry, payload) {
  return {
    type: "pax",
    absolutePath: entry.absolutePath,
    archivePath: safePaxHeaderPath(entry.archivePath),
    stat: entry.stat,
    size: payload.length,
  };
}

function safeHeaderEntry(entry) {
  return {
    ...entry,
    archivePath: safeTarPath(entry.archivePath),
    linkName: entry.type === "symlink" ? safeTarPath(entry.linkName) : entry.linkName,
  };
}

function safePaxHeaderPath(archivePath) {
  return safeTarPath(`PaxHeaders/${archivePath}`);
}

function safeTarPath(archivePath) {
  const normalized = toPosix(archivePath);
  if (Buffer.byteLength(normalized) <= 100) return normalized;
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? "entry";
  const safeBasename = Buffer.byteLength(basename) <= 80 ? basename : basename.slice(-80);
  return `PaxHeaders/${safeBasename}`;
}

function requiresPaxPath(archivePath) {
  try {
    splitTarPath(archivePath);
    return false;
  } catch {
    return true;
  }
}

function paxRecord(key, value) {
  let length = Buffer.byteLength(` ${key}=${value}\n`) + 1;
  while (true) {
    const record = `${length} ${key}=${value}\n`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

function splitTarPath(archivePath) {
  const normalized = toPosix(archivePath);
  if (Buffer.byteLength(normalized) <= 100) return { name: normalized, prefix: "" };
  const parts = normalized.split("/");
  let name = parts.pop();
  let prefix = parts.join("/");
  while (Buffer.byteLength(name) > 100 && parts.length > 0) {
    name = `${parts.pop()}/${name}`;
    prefix = parts.join("/");
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`tar path too long: ${archivePath}`);
  return { name, prefix };
}

function writeString(buffer, value, offset, length) {
  const source = Buffer.from(String(value));
  source.copy(buffer, offset, 0, Math.min(source.length, length));
}

function writeOctal(buffer, value, offset, length) {
  const text = Math.trunc(value).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeString(buffer, text, offset, length - 1);
  buffer[offset + length - 1] = 0;
}

function writeChecksum(buffer, checksum) {
  const text = checksum.toString(8).padStart(6, "0").slice(-6);
  writeString(buffer, text, 148, 6);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function writeFileToStream(filePath, stream) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    const onDrain = () => input.resume();
    const cleanup = () => stream.off("drain", onDrain);
    stream.on("drain", onDrain);
    input.on("data", (chunk) => {
      if (!stream.write(chunk)) input.pause();
    });
    input.on("error", (error) => {
      cleanup();
      reject(error);
    });
    input.on("end", () => {
      cleanup();
      resolve();
    });
  });
}

function padTarEntry(stream, size) {
  const remainder = size % 512;
  if (remainder !== 0) stream.write(Buffer.alloc(512 - remainder));
}

function onceFinished(stream) {
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

// The hosted device-login shell must ship in the app bundle, and desktop
// artifacts stay unpublishable until an end-to-end hosted-world proof is
// recorded as a deliberate build input. Hosted-auth absence keeps false; no
// environment variable can flip this.
const hostedAuthMarkerFiles = [
  path.join("src", "hosted-auth.mjs"),
  path.join("src", "hosted-session.mjs"),
  path.join("src", "shell", "connect.html"),
];

function detectHostedAuthBundled(appBundleRoot) {
  return hostedAuthMarkerFiles.every((relativePath) => {
    try {
      return fs.statSync(path.join(appBundleRoot, relativePath)).isFile();
    } catch {
      return false;
    }
  });
}

function artifactPublishability({ hostedAuthBundled, hostedProofRecorded = false }) {
  if (!hostedAuthBundled) {
    return {
      publishable: false,
      distribution: "Not publishable: this build does not carry the hosted device-login shell.",
    };
  }
  if (!hostedProofRecorded) {
    return {
      publishable: false,
      distribution: "Not publishable until the hosted device-login flow has an end-to-end proof against the hosted world.",
    };
  }
  return {
    publishable: true,
    distribution: "Hosted device-login proven end-to-end against the hosted world.",
  };
}

export {
  artifactPublishability,
  assertNoDuplicateAudio,
  assertNoSymlinkEscape,
  assertProductionClientDist,
  buildDesktop,
  configureMacAppBundle,
  copyTree,
  detectHostedAuthBundled,
  packageSizeBudget,
  prepareElectronRelease,
  resolvePackageMode,
  sha256File,
  targetFor,
  walkTarEntries,
  writeTarGz,
};
