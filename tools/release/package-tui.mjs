#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, lstat, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const TUI_DOWNLOAD_MANIFEST_SCHEMA = "successor.tui-download-manifest.v1";
export const SUPPORTED_TUI_TARGETS = new Set(["linux/x64", "darwin/arm64"]);
export const TUI_PUBLISH_LIMITATION = "Not publishable until the hosted device-flow entry (login, split game/chat tickets) is proven end to end against the hosted world.";
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9._-]+$/u;
const HOSTED_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}@[a-f0-9]{16}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function failure(message, code) { const error = new Error(message); error.code = code; return error; }
function targetKey(platform, arch) { return `${platform}/${arch}`; }
function assertTarget(platform, arch) { if (!SUPPORTED_TUI_TARGETS.has(targetKey(platform, arch))) throw failure(`unsupported TUI target: ${platform}/${arch}`, "UNSUPPORTED_TARGET"); }
function assertId(value, field) { if (typeof value !== "string" || !ID.test(value)) throw failure(`${field} must contain only letters, numbers, '.', '_' or '-'`, "INVALID_ID"); }
function assertReleaseId(value) {
  if (typeof value !== "string" || (!ID.test(value) && !HOSTED_RELEASE_ID.test(value))) {
    throw failure("releaseId must be a legacy safe id or a canonical base@16-hex hosted release id", "INVALID_ID");
  }
}
function assertArchivePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) throw failure(`unsafe archive path: ${value}`, "ARCHIVE_TRAVERSAL");
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw failure(`unsafe archive path: ${value}`, "ARCHIVE_TRAVERSAL");
  if (Buffer.byteLength(value) > 100) throw failure(`archive path is too long: ${value}`, "ARCHIVE_PATH_TOO_LONG");
}
function assertInside(root, candidate, code) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure(`path escapes ${root}: ${candidate}`, code);
}

async function walkDirectory(root, current = root, output = []) {
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink()) throw failure(`symlink is not allowed in TUI dist: ${current}`, "SYMLINK_ESCAPE");
  if (!currentStat.isDirectory()) throw failure(`TUI dist is not a directory: ${root}`, "DIST_INVALID");
  const names = (await readdir(current)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  for (const name of names) {
    const fullPath = path.join(current, name);
    const entryStat = await lstat(fullPath);
    if (entryStat.isSymbolicLink()) throw failure(`symlink is not allowed in TUI dist: ${fullPath}`, "SYMLINK_ESCAPE");
    if (entryStat.isDirectory()) await walkDirectory(root, fullPath, output);
    else if (entryStat.isFile()) output.push({ path: path.relative(root, fullPath).split(path.sep).join("/"), fullPath, mode: entryStat.mode & 0o111 ? 0o755 : 0o644 });
    else throw failure(`unsupported TUI dist entry: ${fullPath}`, "DIST_INVALID");
  }
  return output;
}

async function resolveDistReference(distRoot, sourcePath, reference) {
  if (!reference.startsWith(".")) return;
  const requested = path.resolve(path.dirname(sourcePath), reference);
  assertInside(distRoot, requested, "DIST_REFERENCE_ESCAPE");
  const candidates = [requested, `${requested}.js`, `${requested}.mjs`, path.join(requested, "index.js")];
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  throw failure(`missing TUI dist chunk referenced by ${sourcePath}: ${reference}`, "MISSING_CHUNK");
}

async function validateDistReferences(distRoot, files) {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\brequire\s*\(\s*["']([^"']+)["']/gu,
    /\bnew\s+URL\(\s*["']([^"']+)["']/gu,
  ];
  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/u.test(file.path)) continue;
    const contents = await readFile(file.fullPath, "utf8");
    for (const pattern of patterns) for (const match of contents.matchAll(pattern)) await resolveDistReference(distRoot, file.fullPath, match[1]);
  }
}

function octal(value, width) {
  const text = value.toString(8);
  if (text.length > width - 1) throw failure(`tar field overflow: ${value}`, "ARCHIVE_FIELD_OVERFLOW");
  return `${"0".repeat(width - 1 - text.length)}${text}\0`;
}
function tarHeader(entry) {
  const header = Buffer.alloc(512, 0);
  header.write(entry.path, 0, "utf8");
  header.write(octal(entry.mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(entry.data.length, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(octal(checksum, 8), 148, "ascii");
  return header;
}

export function createDeterministicTarGz(entries) {
  const seen = new Set();
  const chunks = [];
  const sorted = [...entries].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  for (const entry of sorted) {
    assertArchivePath(entry.path);
    if (seen.has(entry.path)) throw failure(`duplicate archive path: ${entry.path}`, "ARCHIVE_DUPLICATE");
    seen.add(entry.path);
    if (!Buffer.isBuffer(entry.data)) throw failure(`archive entry must be a Buffer: ${entry.path}`, "ARCHIVE_ENTRY_INVALID");
    chunks.push(tarHeader({ ...entry, mode: entry.mode ?? 0o644 }), entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}
export const createArchive = createDeterministicTarGz;

async function nodeVersion(runtimePath) {
  let stdout;
  try { ({ stdout } = await execFile(runtimePath, ["--version"], { encoding: "utf8" })); }
  catch (error) { throw failure(`cannot execute bundled Node runtime: ${error.message}`, "RUNTIME_INVALID"); }
  const version = stdout.trim();
  if (!/^v22\.\d+\.\d+$/u.test(version)) throw failure(`TUI artifact requires Node 22; runtime reported ${version}`, "RUNTIME_VERSION");
  return version;
}
async function sourceIdentity(repoRoot, supplied) {
  if (supplied?.commit || supplied?.tree) {
    if (!COMMIT.test(supplied.commit ?? "") || !COMMIT.test(supplied.tree ?? "")) throw failure("source identity must contain 40-hex commit and tree", "SOURCE_INVALID");
    return { commit: supplied.commit, tree: supplied.tree };
  }
  try {
    const [{ stdout: commit }, { stdout: tree }] = await Promise.all([
      execFile("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }),
      execFile("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }),
    ]);
    const identity = { commit: commit.trim(), tree: tree.trim() };
    if (!COMMIT.test(identity.commit) || !COMMIT.test(identity.tree)) throw new Error("invalid git identity");
    return identity;
  } catch (error) { throw failure(`cannot establish source identity: ${error.message}`, "SOURCE_INVALID"); }
}
function requirements(platform, arch, runtimeVersion) {
  const os = platform === "linux" ? "Linux" : "macOS";
  const libc = platform === "linux" ? "; tested on glibc 2.43" : "";
  return [
    `${os} ${arch} userspace compatible with the bundled Node runtime${libc}`,
    `bundled Node.js ${runtimeVersion}; no runtime package installation or network install is required`,
    "bundled open-desert slice; network access to a running Successor game endpoint",
  ];
}

export async function packageTuiArtifact(input) {
  const platform = String(input?.platform ?? "");
  const arch = String(input?.arch ?? "");
  assertTarget(platform, arch);
  assertReleaseId(input?.releaseId);
  assertId(input?.version, "version");
  const distInput = path.resolve(String(input.distDir ?? ""));
  const runtimeInput = path.resolve(String(input.runtimePath ?? ""));
  const sliceInput = path.resolve(String(input.slicePath ?? ""));
  let distRoot;
  let runtimePath;
  let slicePath;
  try {
    const distInputStat = await lstat(distInput);
    if (distInputStat.isSymbolicLink()) throw failure(`symlink is not allowed in TUI dist: ${distInput}`, "SYMLINK_ESCAPE");
    distRoot = await realpath(distInput);
  } catch (error) {
    if (error?.code) throw error;
    throw failure(`cannot read TUI dist: ${error.message}`, "DIST_INVALID");
  }
  try { runtimePath = await realpath(runtimeInput); }
  catch (error) { throw failure(`cannot read bundled Node runtime: ${error.message}`, "RUNTIME_MISSING"); }
  try {
    const sliceInputStat = await lstat(sliceInput);
    if (sliceInputStat.isSymbolicLink()) throw failure(`symlink is not allowed for TUI slice: ${sliceInput}`, "SYMLINK_ESCAPE");
    slicePath = await realpath(sliceInput);
  } catch (error) {
    if (error?.code === "SYMLINK_ESCAPE") throw error;
    throw failure(`cannot read bundled TUI slice: ${error.message}`, "SLICE_MISSING");
  }
  const distStat = await lstat(distRoot);
  const runtimeStat = await lstat(runtimePath);
  const sliceStat = await lstat(slicePath);
  if (!distStat.isDirectory()) throw failure(`TUI dist is not a directory: ${distRoot}`, "DIST_INVALID");
  if (!runtimeStat.isFile()) throw failure(`bundled runtime is not a regular file: ${runtimePath}`, "RUNTIME_INVALID");
  if (!sliceStat.isFile()) throw failure(`bundled TUI slice is not a regular file: ${slicePath}`, "SLICE_INVALID");
  const files = await walkDirectory(distRoot);
  if (!files.some((file) => file.path === "cli.js")) throw failure("TUI dist is missing cli.js", "DIST_ENTRYPOINT_MISSING");
  await validateDistReferences(distRoot, files);
  const runtimeVersion = await nodeVersion(runtimePath);
  const source = await sourceIdentity(path.resolve(String(input.repoRoot ?? process.cwd())), input.source);
  const sliceData = await readFile(slicePath);
  const sliceSha256 = createHash("sha256").update(sliceData).digest("hex");
  const root = `successor-tui-${input.releaseId}`;
  const entrypoint = `${root}/bin/successor-tui`;
  const bundle = {
    schema: "successor.tui-bundle.v1", releaseId: input.releaseId, version: input.version, platform, arch,
    publishable: false, limitation: TUI_PUBLISH_LIMITATION, source,
    runtime: { version: runtimeVersion, path: `${root}/runtime/node` }, slice: { path: `${root}/slice/open-desert-slice.json`, sha256: sliceSha256 },
    entrypoint, requirements: requirements(platform, arch, runtimeVersion),
  };
  const entries = [
    { path: `${root}/runtime/node`, data: await readFile(runtimePath), mode: 0o755 },
    { path: `${root}/bin/successor-tui`, data: Buffer.from("#!/bin/sh\nset -eu\nSOURCE=$0\nSYMLINK_DEPTH=0\nwhile [ -L \"$SOURCE\" ]; do\n  SYMLINK_DEPTH=$((SYMLINK_DEPTH + 1))\n  if [ \"$SYMLINK_DEPTH\" -gt 40 ]; then\n    printf '%s\\n' 'successor-tui: too many symlink levels' >&2\n    exit 1\n  fi\n  TARGET=$(readlink \"$SOURCE\") || {\n    printf 'successor-tui: cannot read symlink: %s\\n' \"$SOURCE\" >&2\n    exit 1\n  }\n  case \"$TARGET\" in\n    /*) SOURCE=$TARGET ;;\n    *) SOURCE=$(dirname -- \"$SOURCE\")/$TARGET ;;\n  esac\ndone\nif [ ! -f \"$SOURCE\" ]; then\n  printf 'successor-tui: launcher target does not exist: %s\\n' \"$SOURCE\" >&2\n  exit 1\nfi\nSELF_DIR=$(CDPATH= cd -- \"$(dirname -- \"$SOURCE\")\" && pwd -P) || {\n  printf 'successor-tui: cannot resolve launcher directory: %s\\n' \"$SOURCE\" >&2\n  exit 1\n}\nexport SUCCESSOR_SLICE_PATH=\"$SELF_DIR/../slice/open-desert-slice.json\"\nexec \"$SELF_DIR/../runtime/node\" \"$SELF_DIR/../dist/cli.js\" \"$@\"\n", "utf8"), mode: 0o755 },
    { path: `${root}/bundle.json`, data: Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8"), mode: 0o644 },
    { path: `${root}/package.json`, data: Buffer.from("{\"type\":\"module\"}\n", "utf8"), mode: 0o644 },
    { path: `${root}/slice/open-desert-slice.json`, data: sliceData, mode: 0o644 },
  ];
  for (const file of files) entries.push({ path: `${root}/dist/${file.path}`, data: await readFile(file.fullPath), mode: file.mode });
  const archive = createDeterministicTarGz(entries);
  const outDir = path.resolve(String(input.outDir ?? path.join(process.cwd(), "artifacts")));
  await mkdir(outDir, { recursive: true });
  const archiveName = `${input.releaseId}-${platform}-${arch}.tar.gz`;
  const archivePath = path.join(outDir, archiveName);
  await writeFile(archivePath, archive, { mode: 0o644 });
  const row = {
    releaseId: input.releaseId, version: input.version, platform, arch, format: "tar.gz", artifact: archiveName,
    bytes: archive.byteLength, sha256: createHash("sha256").update(archive).digest("hex"), entrypoint,
    requirements: bundle.requirements, runtime: runtimeVersion, sliceSha256, publishable: false, limitation: TUI_PUBLISH_LIMITATION, source,
  };
  return { archivePath, row };
}

export async function verifyArtifactRow(row, baseDir = process.cwd()) {
  if (!row || typeof row !== "object" || !SHA256.test(row.sha256 ?? "") || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || typeof row.artifact !== "string") throw failure("artifact row is invalid", "MANIFEST_INVALID");
  const root = path.resolve(baseDir);
  const archivePath = path.resolve(root, row.artifact);
  assertInside(root, archivePath, "ARCHIVE_TRAVERSAL");
  const contents = await readFile(archivePath);
  if (contents.byteLength !== row.bytes) throw failure(`artifact byte count drift: ${row.artifact}`, "CHECKSUM_DRIFT");
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== row.sha256) throw failure(`artifact checksum drift: ${row.artifact}`, "CHECKSUM_DRIFT");
  return true;
}
export async function writeDownloadManifest({ outPath, releaseId, version, source, artifacts }) {
  assertReleaseId(releaseId); assertId(version, "version");
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw failure("manifest needs at least one artifact row", "MANIFEST_INVALID");
  for (const row of artifacts) {
    if (row.releaseId !== releaseId || row.version !== version) throw failure("artifact row release identity does not match manifest", "MANIFEST_INVALID");
    assertTarget(row.platform, row.arch); if (row.format !== "tar.gz") throw failure("unsupported TUI artifact format", "MANIFEST_INVALID");
  }
  const identity = source ?? artifacts[0].source;
  if (!COMMIT.test(identity?.commit ?? "") || !COMMIT.test(identity?.tree ?? "")) throw failure("manifest source identity is invalid", "SOURCE_INVALID");
  const value = { schema: TUI_DOWNLOAD_MANIFEST_SCHEMA, releaseId, version, publishable: false, limitation: TUI_PUBLISH_LIMITATION, source: identity, artifacts: [...artifacts].sort((left, right) => targetKey(left.platform, left.arch).localeCompare(targetKey(right.platform, right.arch))) };
  const destination = path.resolve(String(outPath));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { manifestPath: destination, manifest: value };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]; if (token === "--help") return { help: true };
    if (!token.startsWith("--")) throw failure(`unexpected argument: ${token}`, "USAGE");
    const key = token.slice(2); const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw failure(`missing value for --${key}`, "USAGE");
    args[key] = value; index += 1;
  }
  return args;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write("usage: package-tui.mjs --dist DIR --slice FILE --runtime NODE --out-dir DIR --manifest FILE --release-id ID --version VERSION --platform linux|darwin --arch x64|arm64 [--repo-root DIR]\n"); return; }
  const result = await packageTuiArtifact({ distDir: args.dist, slicePath: args.slice, runtimePath: args.runtime, outDir: args["out-dir"], releaseId: args["release-id"], version: args.version, platform: args.platform, arch: args.arch, repoRoot: args["repo-root"], source: args["source-commit"] && args["source-tree"] ? { commit: args["source-commit"], tree: args["source-tree"] } : undefined });
  const manifest = await writeDownloadManifest({ outPath: args.manifest ?? path.join(args["out-dir"], "tui-download-manifest.json"), releaseId: args["release-id"], version: args.version, source: result.row.source, artifacts: [result.row] });
  process.stdout.write(`${JSON.stringify({ ...result, ...manifest }, null, 2)}\n`);
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { process.stderr.write(`${error.code ?? "ERROR"}: ${error.message}\n`); process.exitCode = 1; });
