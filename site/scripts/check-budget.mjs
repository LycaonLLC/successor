#!/usr/bin/env node
// Performance budget gate from the visual brief. Run after `vite build`.
//   HTML + critical CSS <= 45 KB gzip
//   site JS            <= 40 KB gzip
//   font subsets       <= 80 KB raw
//   hero image         <= 220 KB raw
//   cold transfer, home page before audio <= 450 KB
// Also proves every route ships as a real file for static deep links.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(dist)) {
  console.error("dist/ missing — run `pnpm build` first");
  process.exit(1);
}

const ROUTES = [
  "index.html",
  "account/index.html",
  "connect/index.html",
  "play/index.html",
  "download/index.html",
  "legal/terms/index.html",
  "legal/privacy/index.html",
];

const failures = [];
for (const route of ROUTES) {
  if (!existsSync(join(dist, route))) failures.push(`missing route file: ${route}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const files = walk(dist);
const gzipSize = (path) => gzipSync(readFileSync(path)).length;
const sum = (list, f) => list.reduce((n, item) => n + f(item), 0);

const homeHtmlGz = gzipSize(join(dist, "index.html"));
const cssGz = sum(files.filter((f) => f.endsWith(".css")), gzipSize);
const jsGz = sum(files.filter((f) => f.endsWith(".js")), gzipSize);
const fontBytes = sum(files.filter((f) => f.endsWith(".woff2")), (f) => statSync(f).size);
const hero = files.find((f) => f.includes("hero-dustgate-1600"));
const heroBytes = hero ? statSync(hero).size : Number.POSITIVE_INFINITY;
if (!hero) failures.push("hero image missing from dist");
const faviconPath = join(dist, "favicon.svg");
const faviconBytes = existsSync(faviconPath) ? statSync(faviconPath).size : 0;
const cold = homeHtmlGz + cssGz + jsGz + fontBytes + heroBytes + faviconBytes;

const checks = [
  ["home HTML + CSS (gzip)", homeHtmlGz + cssGz, 45 * 1024],
  ["site JS (gzip)", jsGz, 40 * 1024],
  ["fonts (raw)", fontBytes, 80 * 1024],
  ["hero image (raw)", heroBytes, 220 * 1024],
  ["cold transfer, home before audio", cold, 450 * 1024],
];

for (const [label, actual, budget] of checks) {
  const ok = actual <= budget;
  if (!ok) failures.push(`${label}: ${actual} bytes exceeds ${budget}`);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label.padEnd(36)} ${(actual / 1024).toFixed(1).padStart(7)} KB / ${(budget / 1024).toFixed(0)} KB`,
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} budget failure(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`\nAll budgets met across ${ROUTES.length} routes.`);
