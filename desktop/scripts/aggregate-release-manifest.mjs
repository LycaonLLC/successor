#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

async function main() {
  const { outputPath, artifactPaths } = parseArgs(process.argv.slice(2));
  const manifest = await aggregateReleaseManifest({ outputPath, artifactPaths });
  console.log(JSON.stringify(manifest, null, 2));
}

async function aggregateReleaseManifest({ outputPath, artifactPaths }) {
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) throw new Error("at least one artifact record is required");
  if (!outputPath) throw new Error("--output is required");

  const rows = [];
  for (const artifactPath of artifactPaths) rows.push(await readAndVerifyArtifact(artifactPath));
  const releaseId = rows[0].releaseId;
  const version = rows[0].version;
  const sourceCommit = rows[0].sourceCommit;
  const seenTargets = new Set();
  for (const row of rows) {
    if (row.releaseId !== releaseId) throw new Error(`release ID mismatch in ${row.recordPath}`);
    if (row.version !== version) throw new Error(`version mismatch in ${row.recordPath}`);
    if (row.sourceCommit !== sourceCommit) throw new Error(`source commit mismatch in ${row.recordPath}`);
    const target = `${row.platform}/${row.arch}`;
    if (seenTargets.has(target)) throw new Error(`duplicate artifact target row: ${target}`);
    seenTargets.add(target);
  }

  rows.sort((left, right) => `${left.platform}/${left.arch}/${left.format}`.localeCompare(`${right.platform}/${right.arch}/${right.format}`));
  const manifest = {
    schemaVersion: 1,
    releaseId,
    version,
    sourceCommit,
    artifacts: rows.map(({ recordPath: _recordPath, resolvedArchivePath: _resolvedArchivePath, ...row }) => row),
  };
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

async function readAndVerifyArtifact(recordPath) {
  if (!recordPath) throw new Error("artifact record path is empty");
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read artifact record ${recordPath}: ${error.message}`);
  }
  for (const field of ["releaseId", "version", "platform", "arch", "format", "bytes", "sha256", "archive", "entrypoint", "requirements", "sourceCommit"]) {
    if (!(field in record)) throw new Error(`artifact record ${recordPath} is missing ${field}`);
  }
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) throw new Error(`invalid bytes in ${recordPath}`);
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`invalid SHA-256 in ${recordPath}`);
  if (typeof record.archive !== "string" || !record.archive || path.isAbsolute(record.archive)) throw new Error(`artifact archive must be a relative path in ${recordPath}`);
  if (!record.requirements || typeof record.requirements !== "object" || Array.isArray(record.requirements)) throw new Error(`requirements must be an object in ${recordPath}`);
  if (record.requirements.unsigned !== true) throw new Error(`artifact must explicitly declare unsigned packaging in ${recordPath}`);
  if (typeof record.requirements.signing !== "string" || typeof record.requirements.gatekeeper !== "string") throw new Error(`artifact signing/Gatekeeper requirements are incomplete in ${recordPath}`);

  const recordDirectory = path.dirname(path.resolve(recordPath));
  const resolvedArchivePath = path.resolve(recordDirectory, record.archive);
  if (!isWithin(recordDirectory, resolvedArchivePath)) throw new Error(`artifact archive escapes its record directory in ${recordPath}`);
  let stat;
  try {
    stat = fs.lstatSync(resolvedArchivePath);
  } catch (error) {
    throw new Error(`artifact archive is missing for ${recordPath}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact archive is not a regular file for ${recordPath}`);
  if (stat.size !== record.bytes) throw new Error(`artifact byte count mismatch for ${recordPath}: declared ${record.bytes}, actual ${stat.size}`);
  const actualSha256 = await sha256File(resolvedArchivePath);
  if (actualSha256 !== record.sha256) throw new Error(`artifact checksum mismatch for ${recordPath}: declared ${record.sha256}, actual ${actualSha256}`);

  return { ...record, recordPath, resolvedArchivePath };
}

function parseArgs(args) {
  let outputPath = null;
  const artifactPaths = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      outputPath = args[++index];
      continue;
    }
    if (arg === "--artifact") {
      artifactPaths.push(args[++index]);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown argument: ${arg}`);
    artifactPaths.push(arg);
  }
  return { outputPath, artifactPaths };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export { aggregateReleaseManifest, readAndVerifyArtifact };
