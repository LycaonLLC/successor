import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ledgerSchema = "successor.ledger-entry.v1";

export function createRunId(prefix = "run") {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${prefix}-${timestamp}-${suffix}`;
}

export async function repoSnapshot(repoRoot, { sourceIdentity = null } = {}) {
  const root = path.resolve(repoRoot);
  const statusShort = gitLines(root, ["status", "--short"]);
  return {
    root,
    branch: gitText(root, ["branch", "--show-current"]) || "detached",
    commit: gitText(root, ["rev-parse", "HEAD"]) || "unknown",
    dirty: statusShort.length > 0,
    statusShort,
    packageHash: await hashExistingFiles(root, ["package.json", "pnpm-lock.yaml", "client/package.json", "server/package.json"]),
    ...(sourceIdentity ? {
      sourceHash: sourceIdentity.sourceHash,
      sourceIdentity: {
        schema: sourceIdentity.schema,
        fileCount: sourceIdentity.fileCount,
        totalBytes: sourceIdentity.totalBytes,
        provenance: sourceIdentity.provenance,
      },
    } : {}),
  };
}

export async function appendLedgerEntry(repoRoot, ledger, entry) {
  const ledgerDir = path.join(repoRoot, "verification", "ledgers");
  await fs.mkdir(ledgerDir, { recursive: true });
  const normalized = {
    schema: ledgerSchema,
    ledger,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const line = `${JSON.stringify(normalized)}\n`;
  await fs.appendFile(path.join(ledgerDir, `${ledger}.jsonl`), line, "utf8");
  return normalized;
}

export async function writeJsonArtifact(repoRoot, relativePath, payload) {
  const outputPath = path.join(repoRoot, relativePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relativePath;
}

function gitText(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function gitLines(cwd, args) {
  const text = gitText(cwd, args);
  if (!text) return [];
  return text.split("\n").filter(Boolean);
}

async function hashExistingFiles(root, relativePaths) {
  const hash = crypto.createHash("sha256");
  let included = 0;
  for (const relativePath of relativePaths) {
    try {
      const file = await fs.readFile(path.join(root, relativePath));
      hash.update(relativePath);
      hash.update("\0");
      hash.update(file);
      included += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  hash.update(`included:${included}`);
  return `sha256:${hash.digest("hex")}`;
}
