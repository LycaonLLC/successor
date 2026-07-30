import fs from "node:fs/promises";
import path from "node:path";

const forbiddenSpecifier = /(^|[/@])(?:three|pixi\.js|jsdom|client-3d|runtimeBoot|canvas)(?:$|[/?#])/iu;
const forbiddenDomGlobal = /\b(?:window|document|HTMLElement|HTMLCanvasElement|HTMLImageElement|AudioContext|ImageBitmap|OffscreenCanvas)\b/u;
const sourceExtensions = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".json"];

export async function checkZeroGpuDependencyGraph(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dirname, "../../.."));
  const entries = (options.entries ?? [
    "client/src/headless/cli.ts",
    "client/src/headless/index.ts",
    "tools/verification/play-gate.mjs",
  ]).map((entry) => path.resolve(repoRoot, entry));
  const visited = new Set();
  const files = [];
  const violations = [];
  const simulateImport = options.simulateImport ? path.resolve(repoRoot, options.simulateImport) : null;
  const headlessBoundary = path.resolve(repoRoot, "client", "src", "headless");

  for (const entry of entries) await visit(entry, null);

  return {
    schema: "successor.zero-gpu-check.v1",
    ok: violations.length === 0,
    entries: entries.map((entry) => path.relative(repoRoot, entry)),
    fileCount: files.length,
    files: files.map((file) => path.relative(repoRoot, file)),
    violations,
  };

  async function visit(file, importer) {
    const resolved = await resolveSourceFile(file);
    if (!resolved) {
      if (importer) violations.push({ kind: "missing-local-import", importer: relative(importer), specifier: path.relative(path.dirname(importer), file) });
      return;
    }
    if (visited.has(resolved)) return;
    visited.add(resolved);
    files.push(resolved);
    const relativeFile = relative(resolved);
    if (pathParts(resolved).includes("client-3d")) {
      violations.push({ kind: "forbidden-path", file: relativeFile, match: "client-3d" });
    }
    const source = await fs.readFile(resolved, "utf8");
    const imports = extractRuntimeImports(source);
    if (simulateImport && path.resolve(simulateImport) === resolved) imports.push({ specifier: "three", simulated: true });
    for (const item of imports) {
      const specifier = stripQuery(item.specifier);
      if (forbiddenSpecifier.test(specifier)) {
        violations.push({ kind: item.simulated ? "simulated-forbidden-import" : "forbidden-import", file: relativeFile, specifier: item.specifier });
      }
      if (isRelativeSpecifier(specifier)) {
        const child = path.resolve(path.dirname(resolved), specifier);
        if (isInside(resolved, headlessBoundary) && !isInside(child, headlessBoundary)) continue;
        await visit(child, resolved);
      }
    }
    const sanitized = fileIsChecker(resolved) ? "" : stripCommentsAndStrings(source);
    if (forbiddenDomGlobal.test(sanitized)) {
      violations.push({ kind: "forbidden-dom-global", file: relativeFile, match: sanitized.match(forbiddenDomGlobal)?.[0] ?? "dom" });
    }
  }

  function relative(file) {
    return path.relative(repoRoot, file);
  }
}

export function formatZeroGpuReport(report) {
  if (report.ok) {
    return `zero-gpu check passed (${report.fileCount} files, entries: ${report.entries.join(", ")})`;
  }
  return [
    `ZERO-GPU CHECK FAILED (${report.violations.length} violation(s))`,
    ...report.violations.map((violation) => `- ${violation.kind}: ${violation.file ?? violation.importer}${violation.specifier ? ` -> ${violation.specifier}` : ""}${violation.match ? ` (${violation.match})` : ""}`),
  ].join("\n");
}

export function extractRuntimeImports(source) {
  const imports = [];
  const withoutTypeOnly = source.replace(/\bimport\s+type\s+[\s\S]*?;(?=\s*(?:import|export|$))/gu, "");
  for (const match of withoutTypeOnly.matchAll(/\b(?:import|export)\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/gu)) {
    imports.push({ specifier: match[1] });
  }
  for (const match of withoutTypeOnly.matchAll(/\bimport\s+["']([^"']+)["']/gu)) {
    imports.push({ specifier: match[1] });
  }
  for (const match of withoutTypeOnly.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu)) {
    imports.push({ specifier: match[1] });
  }
  return imports;
}

function stripQuery(specifier) {
  return specifier.split("?")[0].split("#")[0];
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

async function resolveSourceFile(candidate) {
  for (const extension of sourceExtensions) {
    const file = `${candidate}${extension}`;
    if (await isFile(file)) return path.resolve(file);
  }
  for (const extension of sourceExtensions.slice(1)) {
    const file = path.join(candidate, `index${extension}`);
    if (await isFile(file)) return path.resolve(file);
  }
  return null;
}

async function isFile(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1 ")
    .replace(/`(?:\\.|[^`])*`/gu, "``")
    .replace(/"(?:\\.|[^"\\])*"/gu, "\"\"")
    .replace(/'(?:\\.|[^'\\])*'/gu, "''");
}

function isInside(file, root) {
  const relativePath = path.relative(root, file);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function fileIsChecker(file) {
  return path.basename(file) === "zero-gpu-check.mjs";
}

function pathParts(file) {
  return path.normalize(file).split(path.sep);
}
