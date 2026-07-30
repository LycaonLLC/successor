import type { AuthorityClientCommandKind } from "@successor/client/src/slice-core/authorityCommandSystem";
import { authorityIssuedAtServerTick } from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  EXTRACTION_TOAST_KINDS,
  extractionReceiptCopy,
  sampleCooldownToast,
  ticksToSeconds,
  type ExtractionToastKind,
} from "./actions";
import { CAMP_TOAST_KINDS, campReceiptCopy, type CampToastKind } from "../camp/actions";

/**
 * Field-deployable toast line — the HUD receipt/deny voice for the extractor,
 * sampler, and scout-camp command families. One chip in the toolbar-flash
 * visual language, seated one step above it so both can speak at once.
 *
 *  - Rejections flash "DENIED · REASON" (commandReceipts voice).
 *  - Accepted place/collect/insert/pack-up receipts flash their copy;
 *    cranks and camp placements stay silent — the world prop appearing or
 *    animating IS the feedback (a struck camp vanishes, so THAT speaks).
 *  - `sample_cooldown` rejects hold a LIVE countdown driven by the owner
 *    actor's `nextSampleTick` (tick→wall-clock via the swing-timer anchor,
 *    never a client timer), dismissing at zero or when the loop breaks.
 */
export interface ExtractionHudController {
  dispose: () => void;
}

const FLASH_MS = 1600;
/** Static fallback when the cooldown reject beat the actor-state patch. */
const COOLDOWN_FALLBACK_MS = 3200;

const WATCHED_KINDS: ReadonlySet<AuthorityClientCommandKind> = new Set([...EXTRACTION_TOAST_KINDS, ...CAMP_TOAST_KINDS]);

function isExtractionToastKind(kind: AuthorityClientCommandKind): kind is ExtractionToastKind {
  return (EXTRACTION_TOAST_KINDS as readonly string[]).includes(kind);
}

function isCampToastKind(kind: AuthorityClientCommandKind): kind is CampToastKind {
  return (CAMP_TOAST_KINDS as readonly string[]).includes(kind);
}

export function mountExtractionHud(shell: HTMLElement, state: PlayState, slice: SliceSnapshot): ExtractionHudController {
  const line = document.createElement("div");
  line.className = "sc3d-extraction-flash";
  line.hidden = true;
  shell.appendChild(line);

  let lastReceiptCommandId = state.serverAuthority.lastReceipt?.commandId ?? -1;
  let flashUntilMs = 0;
  let cooldownActive = false;
  let cooldownStartedAtMs = 0;
  let appliedText = "";

  const setLine = (text: string, bad: boolean): void => {
    if (appliedText !== text) {
      appliedText = text;
      line.textContent = text;
    }
    line.toggleAttribute("data-bad", bad);
    line.hidden = false;
  };

  const hideLine = (): void => {
    if (line.hidden) return;
    line.hidden = true;
    appliedText = "";
  };

  const localSampleRemainingTicks = (): number | null => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const nextSampleTick = state.serverAuthority.actors[actorId]?.nextSampleTick ?? 0;
    if (nextSampleTick <= 0) return null;
    const estimatedTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    return nextSampleTick - estimatedTick;
  };

  let frameId = 0;
  const frame = (): void => {
    frameId = requestAnimationFrame(frame);
    const nowMs = performance.now();

    // New receipt of a watched kind → flash or arm the countdown.
    const receipt = state.serverAuthority.lastReceipt;
    if (receipt && receipt.commandId !== lastReceiptCommandId) {
      lastReceiptCommandId = receipt.commandId;
      const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
      if (sent && WATCHED_KINDS.has(sent.kind)) {
        if (!receipt.accepted && sent.kind === "SampleResource" && receipt.reasonCode === "sample_cooldown") {
          cooldownActive = true;
          cooldownStartedAtMs = nowMs;
        } else {
          const copy = isCampToastKind(sent.kind)
            ? campReceiptCopy(sent.kind, receipt.accepted, receipt.reasonCode ?? null)
            : isExtractionToastKind(sent.kind)
              ? extractionReceiptCopy(sent.kind, receipt.accepted, receipt.reasonCode ?? null)
              : null;
          if (copy) {
            cooldownActive = false;
            setLine(copy, !receipt.accepted);
            flashUntilMs = nowMs + FLASH_MS;
          }
        }
      }
    }

    if (cooldownActive) {
      const remainingTicks = localSampleRemainingTicks();
      if (remainingTicks === null) {
        // Loop broke (or the arming patch hasn't landed): hold a static
        // denial briefly, never a countdown invented from a client clock.
        if (nowMs - cooldownStartedAtMs > COOLDOWN_FALLBACK_MS) {
          cooldownActive = false;
          hideLine();
        } else {
          setLine("DENIED · SAMPLE COOLDOWN", true);
        }
        return;
      }
      const seconds = ticksToSeconds(remainingTicks, slice.tickRateHz);
      if (seconds <= 0) {
        cooldownActive = false;
        hideLine();
        return;
      }
      setLine(sampleCooldownToast(seconds), true);
      return;
    }

    if (!line.hidden && nowMs > flashUntilMs) hideLine();
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose(): void {
      cancelAnimationFrame(frameId);
      line.remove();
    },
  };
}
