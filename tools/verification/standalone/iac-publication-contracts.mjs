#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const required = ["ops/deploy/validate.sh", "ops/deploy", "site/package.json", "tools/release/seal.mjs"];
for (const relative of required) {
  try { await fs.stat(path.join(root, relative)); } catch { throw new Error(`publication/IaC contract missing: ${relative}`); }
}
const files = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (entry.isFile() && /\.(tf|tfvars|mjs|json|sh)$/u.test(entry.name)) files.push(child);
  }
}
await walk(path.join(root, "ops"));
const forbidden = /(?:AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|BEGIN PRIVATE KEY|password\s*=\s*["'][^"']+)/u;
for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  if (forbidden.test(text)) throw new Error(`credential-like value in IaC/publication contract: ${path.relative(root, file)}`);
}
console.log(JSON.stringify({ schema: "successor.standalone-iac-publication-contracts.v1", status: "pass", backend: false, filesChecked: files.length, writes: false, publication: false }));
