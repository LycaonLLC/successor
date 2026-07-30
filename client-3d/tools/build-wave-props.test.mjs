import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const script = path.resolve(import.meta.dirname, "build-wave-props.mjs");

function runBuilder({ cwd, sourceRoot, outputRoot }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { ...process.env, SUCCESSOR_SOURCE_ASSETS: sourceRoot, WAVE_PROPS_OUTPUT: outputRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("missing source from a wrong working directory preserves the existing catalog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "successor-wave-builder-"));
  const cwd = path.join(root, "wrong-cwd");
  const output = path.join(root, "wave-props");
  await mkdir(cwd, { recursive: true });
  await mkdir(output, { recursive: true });
  const sentinel = path.join(output, "sentinel.txt");
  await writeFile(sentinel, "preserve-me\n");

  const result = await runBuilder({ cwd, sourceRoot: path.join(root, "missing-source-assets"), outputRoot: output });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Missing source unit/u);
  assert.equal(await readFile(sentinel, "utf8"), "preserve-me\n");
});
