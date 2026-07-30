import type { PlayState } from "@successor/client/src/slice-core/gameState";

/** Small enough for journey correlation without turning the probe into history. */
export const AUTHORITY_RECEIPT_PROBE_TAIL_LIMIT = 16;

type CanonicalAuthorityReceipt = PlayState["serverAuthority"]["receiptLog"][number];
type CanonicalSentCommand = PlayState["serverAuthority"]["sentCommandLog"][number];

/** Read-only authority evidence projected onto the canonical browser probe. */
export interface AuthorityReceiptProbeEntry {
  commandId: number;
  kind: CanonicalSentCommand["kind"] | null;
  accepted: boolean;
  issuedAtTick: number | null;
  tick: number;
  reasonCode: string | null;
}

/**
 * Project the canonical transport receipt tail into caller-owned probe storage.
 *
 * The target is updated in place so frames with no new receipts allocate
 * nothing. Only scalar evidence is copied; this is not a second receipt stream
 * and cannot mutate transport or gameplay state.
 */
export function syncAuthorityReceiptProbeTail(
  target: AuthorityReceiptProbeEntry[],
  receiptLog: readonly CanonicalAuthorityReceipt[],
  sentCommandLog: readonly CanonicalSentCommand[],
): void {
  const start = Math.max(0, receiptLog.length - AUTHORITY_RECEIPT_PROBE_TAIL_LIMIT);
  const count = receiptLog.length - start;

  for (let outputIndex = 0; outputIndex < count; outputIndex += 1) {
    const receipt = receiptLog[start + outputIndex]!;
    let kind: CanonicalSentCommand["kind"] | null = null;
    let issuedAtTick: number | null = null;

    for (let sentIndex = sentCommandLog.length - 1; sentIndex >= 0; sentIndex -= 1) {
      const sent = sentCommandLog[sentIndex]!;
      if (sent.commandId !== receipt.commandId) continue;
      kind = sent.kind;
      issuedAtTick = sent.issuedAtTick ?? null;
      break;
    }

    const current = target[outputIndex];
    if (current) {
      current.commandId = receipt.commandId;
      current.kind = kind;
      current.accepted = receipt.accepted;
      current.issuedAtTick = issuedAtTick;
      current.tick = receipt.tick;
      current.reasonCode = receipt.reasonCode ?? null;
    } else {
      target.push({
        commandId: receipt.commandId,
        kind,
        accepted: receipt.accepted,
        issuedAtTick,
        tick: receipt.tick,
        reasonCode: receipt.reasonCode ?? null,
      });
    }
  }

  target.length = count;
}
