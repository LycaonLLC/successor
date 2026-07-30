#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const baseRef = process.env.SUCCESSOR_PRIVATE_PATH_BASE ?? "hub/main";
const allowlistedFixturePaths = new Set([
  "client-tui/src/game/localMacroFiles.test.ts",
]);
const unsafePatterns = [
  { label: "private home path", pattern: /(?:^|["'`])\/home\/lycaon(?:\/|["'`]|$)/u },
  { label: "private macOS user path", pattern: /(?:^|["'`])\/Users\/[^/\s"'`]+(?:\/|["'`]|$)/u },
  { label: "private volume path", pattern: /(?:^|["'`])\/Volumes\/(?:[^/\s"'`]+)(?:\/|["'`]|$)/u },
  { label: "unsafe temporary absolute path", pattern: /(?:^|["'`])\/tmp\/(?!successor-|test-|xdg|movement-lab|tone-probe|extractor_|bodyprom|visualsweep|tui-)[^\s"'`]+/u },
];

const files = changedFiles();
const failures = [];
for (const file of files) {
  if (allowlistedFixturePaths.has(file)) continue;
  const absolute = path.join(repoRoot, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const text = fs.readFileSync(absolute, "utf8");
  if (text.includes("\u0000")) continue;
  for (const { label, pattern } of unsafePatterns) {
    const match = text.match(pattern);
    if (match) failures.push(`${file}: ${label}: ${match[0]}`);
  }
}
if (failures.length) {
  console.error("Private path gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Private path gate passed (${files.length} changed tracked files checked).`);

function changedFiles() {
  const result = childProcess.spawnSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git diff against ${baseRef} failed: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
