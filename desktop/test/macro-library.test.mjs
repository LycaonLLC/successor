import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listMacroFiles, MACRO_FILE_LIMITS } from "../src/macro-library.mjs";

function tempMacroDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-macro-test-"));
  return dir;
}

function fileByName(result, fileName) {
  const row = result.files.find((entry) => entry.fileName === fileName);
  assert.ok(row, `expected listing row for ${fileName}`);
  return row;
}

test("published limits mirror the slice-core local macro rules", () => {
  assert.equal(MACRO_FILE_LIMITS.extension, ".macro");
  assert.equal(MACRO_FILE_LIMITS.maxFiles, 64);
  assert.equal(MACRO_FILE_LIMITS.maxBytes, 8192);
});

test("missing directory is an empty listing, not an error", () => {
  const dir = path.join(tempMacroDir(), "never-created");
  const result = listMacroFiles(dir);
  assert.deepEqual(result, { ok: true, dir, files: [], truncated: false });
});

test("reads well-formed UTF-8 .macro files and ignores other extensions", () => {
  const dir = tempMacroDir();
  fs.writeFileSync(path.join(dir, "field check.macro"), "# report\n/where\n/vitals\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a macro");
  const result = listMacroFiles(dir);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], {
    name: "field check",
    fileName: "field check.macro",
    bytes: 24,
    body: "# report\n/where\n/vitals\n",
  });
});

test("rejects invalid names, oversize bodies, and invalid UTF-8 per file", () => {
  const dir = tempMacroDir();
  fs.writeFileSync(path.join(dir, ".hidden.macro"), "/where\n");
  fs.writeFileSync(path.join(dir, "big.macro"), "x".repeat(MACRO_FILE_LIMITS.maxBytes + 1));
  fs.writeFileSync(path.join(dir, "bad-utf8.macro"), Buffer.from([0x2f, 0x77, 0xff, 0xfe]));
  fs.writeFileSync(path.join(dir, "good.macro"), "/where\n");
  const result = listMacroFiles(dir);
  assert.equal(result.ok, true);
  assert.equal(fileByName(result, ".hidden.macro").error, "invalid name");
  assert.match(fileByName(result, "big.macro").error, /^oversize \(8193 > 8192 bytes\)$/);
  assert.equal(fileByName(result, "bad-utf8.macro").error, "invalid UTF-8");
  assert.equal(fileByName(result, "good.macro").body, "/where\n");
  // Error rows never carry a body.
  for (const row of result.files) {
    if (row.error) assert.equal(row.body, undefined);
  }
});

test("rejects symlinks (inside or outside the dir) and non-regular files", () => {
  const dir = tempMacroDir();
  const outside = path.join(tempMacroDir(), "escape.macro");
  fs.writeFileSync(outside, "/where\n");
  fs.writeFileSync(path.join(dir, "real.macro"), "/where\n");
  fs.symlinkSync(outside, path.join(dir, "link-out.macro"));
  fs.symlinkSync(path.join(dir, "real.macro"), path.join(dir, "link-in.macro"));
  fs.mkdirSync(path.join(dir, "subdir.macro"));
  const result = listMacroFiles(dir);
  assert.equal(result.ok, true);
  assert.equal(fileByName(result, "link-out.macro").error, "symlink rejected");
  assert.equal(fileByName(result, "link-in.macro").error, "symlink rejected");
  assert.equal(fileByName(result, "subdir.macro").error, "not a regular file");
  assert.equal(fileByName(result, "real.macro").body, "/where\n");
});

test("truncates deterministically (byte-order name sort) above maxFiles", () => {
  const dir = tempMacroDir();
  for (const name of ["delta", "alpha", "echo", "charlie", "bravo"]) {
    fs.writeFileSync(path.join(dir, `${name}.macro`), `# ${name}\n/where\n`);
  }
  const limits = { ...MACRO_FILE_LIMITS, maxFiles: 3 };
  const result = listMacroFiles(dir, limits);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.files.map((row) => row.fileName),
    ["alpha.macro", "bravo.macro", "charlie.macro"],
  );
});

test("unreadable directory path is a deterministic directory-level error", () => {
  const dir = tempMacroDir();
  const notADir = path.join(dir, "file-not-dir");
  fs.writeFileSync(notADir, "plain file");
  const result = listMacroFiles(notADir);
  assert.equal(result.ok, false);
  assert.match(result.error, /^macro directory unreadable: /);
});
