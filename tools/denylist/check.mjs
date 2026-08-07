#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const denylistPath = join(scriptDir, "denylist.txt");
const baselinePath = join(scriptDir, "baseline.tsv");

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function lines(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    fail(`required denylist file not found: ${path}`);
  }
}

const terms = lines(denylistPath)
  .map((line) => line.replace(/\s+$/, ""))
  .filter((line) => line && !/^\s*#/.test(line));
if (terms.length === 0) fail("denylist is empty; nothing to check", 0);

const baseline = new Map();
for (const line of lines(baselinePath)) {
  if (!line || line.startsWith("#")) continue;
  const [path, term, countText, ...extra] = line.split("\t");
  const count = Number(countText);
  if (!path || !term || extra.length || !Number.isInteger(count) || count < 1) {
    fail(`invalid denylist baseline entry: ${path ?? line}`);
  }
  const key = `${path}\t${term.toLocaleLowerCase("en-US")}`;
  if (baseline.has(key)) fail(`duplicate denylist baseline entry: ${path} ${term}`);
  baseline.set(key, count);
}

function isWord(char) {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function countTerm(content, term) {
  const source = content.toLocaleLowerCase("en-US");
  const needle = term.toLocaleLowerCase("en-US");
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    const before = source[offset - 1];
    const after = source[offset + needle.length];
    if ((!isWord(needle[0]) || !isWord(before)) &&
        (!isWord(needle[needle.length - 1]) || !isWord(after))) count += 1;
    offset += Math.max(needle.length, 1);
  }
  return count;
}

function textAt(path) {
  try {
    const data = readFileSync(path);
    if (data.includes(0)) return null;
    return data.toString("utf8");
  } catch {
    return null;
  }
}

function hits(content) {
  return terms.filter((term) => countTerm(content, term) > 0);
}

function checkOne(subject, content) {
  const found = hits(content);
  if (!found.length) return true;
  console.error(`DENYLIST HIT in ${subject}:`);
  for (const term of found) console.error(`  ${term}`);
  return false;
}

const args = process.argv.slice(2);
if (args[0] === "--prompt" && args.length === 2) {
  if (!checkOne("<prompt>", args[1])) process.exit(1);
  console.log("prompt clean.");
  process.exit(0);
}
if (args[0] === "--files" && args.length >= 2) {
  let clean = true;
  for (const path of args.slice(1)) {
    const content = textAt(path);
    if (content !== null && !checkOne(path, content)) clean = false;
  }
  process.exit(clean ? 0 : 1);
}
if (args.length) fail(`unknown arg: ${args[0]}`);

const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (git.status !== 0) fail("denylist repository scan requires a Git checkout");
const files = git.stdout.split(/\r?\n/).filter(Boolean);
const badPaths = files.filter((path) => /(^|\/)reference\//.test(path));
if (badPaths.length) {
  console.error("tracked paths contain 'reference/' (reference vault must stay outside repo):");
  for (const path of badPaths) console.error(`  ${path}`);
  process.exit(1);
}

const excluded = /^(tools\/denylist\/.*|tools\/verification\/coverage\/temp-[^/]+\.json|docs\/(AI_PROMPT_DENYLIST|SOURCE_ISOLATION|PRODUCT_IDENTITY_BIBLE|RISK_REGISTER)\.md|docs\/adr\/.*\.md|README\.md|PLAN\.md|CONTRIBUTING\.md)$/;
const binary = /\.(png|jpg|jpeg|gif|webp|wav|ogg|mp3|mp4|glb|gltf|ktx2|basis|bin|zip|tar|gz|woff|woff2|ttf|otf|ico|pdf)$/i;
const scanned = files.filter((path) => !excluded.test(path) && !binary.test(path));
const current = new Map();
for (const path of scanned) {
  const absolute = join(repoRoot, path);
  try {
    if (!statSync(absolute).isFile()) continue;
  } catch {
    continue;
  }
  const content = textAt(absolute);
  if (content === null) continue;
  for (const term of terms) {
    const count = countTerm(content, term);
    if (count) current.set(`${path}\t${term.toLocaleLowerCase("en-US")}`, count);
  }
}

let clean = true;
for (const [key, allowed] of baseline) {
  const actual = current.get(key) ?? 0;
  if (actual === allowed) continue;
  const [path, term] = key.split("\t");
  console.error(`${actual > allowed ? "DENYLIST HIT" : "DENYLIST BASELINE STALE"} in ${path}:`);
  console.error(`  ${term} (allowed ${allowed} occurrences, found ${actual})`);
  clean = false;
}
for (const [key, count] of current) {
  if (baseline.has(key)) continue;
  const [path, term] = key.split("\t");
  console.error(`DENYLIST HIT in ${path}:`);
  console.error(`  ${term} (new occurrence count: ${count})`);
  clean = false;
}
if (!clean) process.exit(1);
console.log(`denylist check passed (${scanned.length} files, ${terms.length} terms, ${baseline.size} baseline entries).`);
