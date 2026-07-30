import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rawClientCommandSchema } from "./protocol.js";

// DEF-7 systemic gate (zod hop): every command kind the generated manifest
// advertises must satisfy the client-command zod union. The bug this ends:
// a botched union merge (GeneSample folded INTO DuelYield's member) made both
// members require each other's key, so both silently dropped at the room. This
// test drives a minimal manifest-derived payload per kind through the union.
// Pairs with the Rust bridge round-trip gate (DEF-8) for full 3-hop coverage.

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "../../../tools/codegen/generated/successor.commands.manifest.v1.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  commands: Array<{ kind: string; debugGated?: boolean; args: Array<{ name: string; type: string; required: boolean; domain?: string; enumValues?: string[]; repeated?: boolean }> }>;
};

// Explicit valid payloads for commands whose zod shape is nested/constrained
// beyond what the flat manifest args describe.
const OVERRIDES: Record<string, unknown> = {
  ProposeTrade: { partner_actor_id: "p", offer: [{ item_id: 1, variant_id: 0, quantity: 1 }], request: [] },
  AddTradeItem: { proposal_id: 1, item: { item_id: 1, variant_id: 0, quantity: 1 } },
  RemoveTradeItem: { proposal_id: 1, item: { item_id: 1, variant_id: 0, quantity: 1 } },
};

// id-domains whose zod type is z.number() (a numeric id), not a string.
const NUMERIC_ID_DOMAINS = new Set([
  "item_numeric_id",
  "inventory_item_numeric_id",
  "item_variant_id",
  "trade_proposal_id",
]);

function synthesize(args: (typeof manifest)["commands"][number]["args"]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const arg of args) {
    if (!arg.required) continue; // minimal payload: required fields only
    let value: unknown;
    switch (arg.type) {
      case "bool": value = true; break;
      case "enum": value = arg.enumValues?.[0] ?? "x"; break;
      case "milli": value = 1; break;
      case "int": value = 1; break;
      default:
        value = NUMERIC_ID_DOMAINS.has((arg as { domain?: string }).domain ?? "") ? 1 : "x";
        break; // id-domain: numeric vs string by domain
    }
    payload[arg.name] = arg.repeated ? [value] : value;
  }
  return payload;
}

describe("client command schema coverage (DEF-7 zod satisfiability gate)", () => {
  it("parses a manifest-derived sample for every non-debug command kind", () => {
    const failures: string[] = [];
    let covered = 0;
    for (const command of manifest.commands) {
      if (command.debugGated) continue; // debug commands ride a separate gated path
      covered += 1;
      const payload = OVERRIDES[command.kind] ?? synthesize(command.args);
      const result = rawClientCommandSchema.safeParse({ [command.kind]: payload });
      if (!result.success) {
        failures.push(`${command.kind}: ${result.error.issues.map((i) => i.message).join("; ")}`);
      }
    }
    expect(covered).toBeGreaterThan(80);
    expect(failures, `unsatisfiable command kinds (union merge / missing member):\n${failures.join("\n")}`).toEqual([]);
  });
});
