import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AlphaControlStore } from "../alpha/control-store.js";

const roots: string[] = [];
const script = fileURLToPath(new URL("../../scripts/bugreports.mjs", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bug report operator lookup", () => {
  it("lists and retrieves reports from the read-only ledger command", () => {
    const root = mkdtempSync(join(tmpdir(), "successor-bugreports-cli-"));
    roots.push(root);
    const dbPath = join(root, "control.sqlite");
    const store = new AlphaControlStore({
      dbPath,
      claimSecret: Buffer.alloc(32, 0x11),
      now: () => Date.UTC(2026, 6, 29, 19, 0, 0),
    });
    const stored = store.createBugReport({
      requestId: "6e934dfe-e9da-4d15-8da4-e6e32b7d5ab8",
      ownerRef: "owner-cli",
      characterId: "char-cli",
      shardId: "open-desert",
      clientReleaseId: "client-cli",
      serverReleaseId: "server-cli",
      category: "interface",
      body: "The inventory window stayed open after I pressed its close control.",
      diagnostics: { schema: "successor.bug-report-diagnostics.v1", tick: 42 },
    });

    const env = { ...process.env, ALPHA_CONTROL_DB_PATH: dbPath };
    const listed = JSON.parse(execFileSync(process.execPath, [
      script,
      "list",
      "--json",
    ], { env, encoding: "utf8" })) as Array<Record<string, unknown>>;
    expect(listed).toEqual([
      expect.objectContaining({
        reportId: stored.reportId,
        status: "open",
        characterId: "char-cli",
      }),
    ]);

    const shown = JSON.parse(execFileSync(process.execPath, [
      script,
      "show",
      stored.reportId,
    ], { env, encoding: "utf8" })) as Record<string, unknown>;
    expect(shown).toMatchObject({
      reportId: stored.reportId,
      category: "interface",
      diagnostics: { schema: "successor.bug-report-diagnostics.v1", tick: 42 },
    });
    store.close();
  });
});
