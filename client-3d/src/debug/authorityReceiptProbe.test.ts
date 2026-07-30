import { describe, expect, it } from "vitest";

import type { PlayState } from "@successor/client/src/slice-core/gameState";
import {
  AUTHORITY_RECEIPT_PROBE_TAIL_LIMIT,
  syncAuthorityReceiptProbeTail,
  type AuthorityReceiptProbeEntry,
} from "./authorityReceiptProbe";

type CanonicalReceipt = NonNullable<PlayState["serverAuthority"]["lastReceipt"]>;
type CanonicalSentCommand = PlayState["serverAuthority"]["sentCommandLog"][number];

function receipt(commandId: number, accepted: boolean, tick: number, reasonCode?: string): CanonicalReceipt {
  return {
    commandId,
    accepted,
    tick,
    receivedAtMs: 1_000 + commandId,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  };
}

function sent(commandId: number, kind: CanonicalSentCommand["kind"], issuedAtTick?: number): CanonicalSentCommand {
  return {
    commandId,
    kind,
    sentAtMs: 2_000 + commandId,
    ...(issuedAtTick === undefined ? {} : { issuedAtTick }),
  };
}

describe("authority receipt probe tail", () => {
  it("clears stale probe entries when canonical receipt state is empty", () => {
    const target: AuthorityReceiptProbeEntry[] = [
      { commandId: 99, kind: "Move", accepted: true, issuedAtTick: 90, tick: 91, reasonCode: null },
    ];

    syncAuthorityReceiptProbeTail(target, [], []);

    expect(target).toEqual([]);
  });

  it("projects an accepted QueueCombatAction receipt with exact identity, kind, and ticks", () => {
    const target: AuthorityReceiptProbeEntry[] = [];

    syncAuthorityReceiptProbeTail(target, [receipt(104, true, 712)], [sent(104, "QueueCombatAction", 709)]);

    expect(target).toEqual([
      {
        commandId: 104,
        kind: "QueueCombatAction",
        accepted: true,
        issuedAtTick: 709,
        tick: 712,
        reasonCode: null,
      },
    ]);
  });

  it("projects a rejected receipt reason without dropping its command evidence", () => {
    const target: AuthorityReceiptProbeEntry[] = [];

    syncAuthorityReceiptProbeTail(target, [receipt(205, false, 818, "out_of_range")], [sent(205, "QueueCombatAction", 815)]);

    expect(target).toEqual([
      {
        commandId: 205,
        kind: "QueueCombatAction",
        accepted: false,
        issuedAtTick: 815,
        tick: 818,
        reasonCode: "out_of_range",
      },
    ]);
  });

  it("retains receipts with unavailable sent-command metadata using stable null fields", () => {
    const target: AuthorityReceiptProbeEntry[] = [];

    syncAuthorityReceiptProbeTail(target, [receipt(301, true, 900)], []);

    expect(target).toEqual([
      { commandId: 301, kind: null, accepted: true, issuedAtTick: null, tick: 900, reasonCode: null },
    ]);
  });

  it("keeps the fixed latest receipt cap in chronological order", () => {
    const receiptLog = Array.from({ length: AUTHORITY_RECEIPT_PROBE_TAIL_LIMIT + 2 }, (_, index) =>
      receipt(index + 1, index % 2 === 0, 500 + index),
    );
    const sentCommandLog = receiptLog.map((entry) => sent(entry.commandId, "Move", 400 + entry.commandId));
    const target: AuthorityReceiptProbeEntry[] = [];

    syncAuthorityReceiptProbeTail(target, receiptLog, sentCommandLog);

    expect(target).toHaveLength(AUTHORITY_RECEIPT_PROBE_TAIL_LIMIT);
    expect(target.map((entry) => entry.commandId)).toEqual(
      Array.from({ length: AUTHORITY_RECEIPT_PROBE_TAIL_LIMIT }, (_, index) => index + 3),
    );
    expect(target[0]).toMatchObject({ kind: "Move", issuedAtTick: 403, tick: 502 });
    expect(target.at(-1)).toMatchObject({ kind: "Move", issuedAtTick: 418, tick: 517 });
  });

  it("copies canonical evidence without aliasing it and reuses probe entries on a stable frame", () => {
    const canonicalReceipt = receipt(412, false, 1_024, "ingress_budget_exhausted");
    const canonicalSentCommand = sent(412, "QueueCombatAction", 1_020);
    const target: AuthorityReceiptProbeEntry[] = [];

    syncAuthorityReceiptProbeTail(target, [canonicalReceipt], [canonicalSentCommand]);
    const projected = target[0]!;
    projected.commandId = -1;
    projected.kind = "Move";
    projected.accepted = true;
    projected.issuedAtTick = -2;
    projected.tick = -3;
    projected.reasonCode = "mutated_probe_only";

    expect(canonicalReceipt).toEqual(receipt(412, false, 1_024, "ingress_budget_exhausted"));
    expect(canonicalSentCommand).toEqual(sent(412, "QueueCombatAction", 1_020));

    syncAuthorityReceiptProbeTail(target, [canonicalReceipt], [canonicalSentCommand]);

    expect(target[0]).toBe(projected);
    expect(target).toEqual([
      {
        commandId: 412,
        kind: "QueueCombatAction",
        accepted: false,
        issuedAtTick: 1_020,
        tick: 1_024,
        reasonCode: "ingress_budget_exhausted",
      },
    ]);
  });
});
