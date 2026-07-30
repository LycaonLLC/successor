import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const scannedRoots = ["src"];
const forbiddenImport = /from\s+["'][^"']*(?:three|pixi\.js|jsdom|runtimeBoot|canvas|ink|blessed|react)[^"']*["']/iu;
const forbiddenPackage = /["'](?:three|pixi\.js|jsdom|ink|blessed|react|react-dom)["']/iu;
const forbiddenGlobals = new RegExp(`\\b(?:${["win", "dow"].join("")}|${["doc", "ument"].join("")}|HTMLElement|HTMLCanvasElement|AudioContext|Image)\\b`, "u");

describe("client-tui zero GPU/DOM contract", () => {
  it("keeps the TUI package free of renderer/browser dependencies and globals", async () => {
    const files = await collectPackageFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const codeOnly = stripTypeScriptComments(source);
      expect(source, file).not.toMatch(forbiddenImport);
      expect(codeOnly, file).not.toMatch(forbiddenGlobals);
      if (path.basename(file) === "package.json") {
        expect(source, file).not.toMatch(forbiddenPackage);
      }
    }
  });
});

function stripTypeScriptComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

async function collectPackageFiles(): Promise<string[]> {
  const files = [path.join(packageRoot, "package.json"), path.join(packageRoot, "vite.config.ts")];
  for (const root of scannedRoots) {
    files.push(...await collectTsFiles(path.join(packageRoot, root)));
  }
  return files.sort();
}

async function collectTsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTsFiles(fullPath));
    } else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}
