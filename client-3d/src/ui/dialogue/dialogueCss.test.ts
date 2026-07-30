import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "dialogue.css"), "utf8");

describe("converse window CSS", () => {
  it("keeps the hidden empty-state overlay out of pointer hit-testing", () => {
    expect(css).toMatch(/\.scv-empty\[hidden\]\s*\{[^}]*display:\s*none\s*;/su);
  });
});
