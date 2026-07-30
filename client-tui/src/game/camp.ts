/**
 * /camp — the scout camp as terminal flows (CampFE/CampWeatherSim wire).
 *
 * State is the per-observer placedCamps stream (full-replace per delta):
 * own camp renders status + grace honesty (formatAbandonCountdown);
 * foreign camps are scenery presence only, matching the extractor
 * posture. Pitch/strike ride the generated PlaceCamp/PackUpCamp verbs;
 * strike is lossy (NOTHING RETURNS) and takes the armed-confirm grammar.
 * Shelter truth reuses the shared pointInsideCampShelter helper — the
 * same box the 3D SHELTERED plate reads (audit §5, closed as
 * prescribed).
 */

import type { PlayState, ServerAuthorityPlacedCampState } from "@successor/client/src/slice-core/gameState";
import { formatAbandonCountdown, pointInsideCampShelter } from "@successor/client/src/slice-core/campSystem";
import { windFor, windShort } from "./bearing";
import type { CommandLineOut } from "../commands";
import type { GameSession } from "./session";
import type { ArmedConfirm } from "./armedConfirm";

function playerPosition(state: PlayState): { x: number; y: number } {
  const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
  return { x: me?.x ?? state.player.x, y: me?.y ?? state.player.y };
}

function ownCamp(state: PlayState): ServerAuthorityPlacedCampState | null {
  return state.serverAuthority.placedCamps.find((camp) => camp.isOwner) ?? null;
}

/** True when the player stands inside their own camp's shelter box. */
export function sheltered(state: PlayState): boolean {
  const camp = ownCamp(state);
  if (!camp) return false;
  const at = playerPosition(state);
  return pointInsideCampShelter([camp], state.activeAreaId, at.x, at.y);
}

/** /camp status — own camp truth + foreign presence, all from the stream. */
export function campStatusLines(state: PlayState): CommandLineOut[] {
  const lines: CommandLineOut[] = [];
  const mine = ownCamp(state);
  if (mine) {
    const at = playerPosition(state);
    const dx = mine.cellX - at.x;
    const dy = mine.cellY - at.y;
    const distance = Math.hypot(dx, dy);
    const where = distance <= 1.5 ? "under your canvas" : `${windShort(windFor(dx, dy))} ${Math.round(distance)}c`;
    if (mine.abandonSecondsRemaining !== undefined && mine.abandonSecondsRemaining !== null) {
      lines.push({
        register: "receipt",
        text: `Your camp stands ${where} — abandoned, collapses in ${formatAbandonCountdown(mine.abandonSecondsRemaining)}. Returning resets it.`,
      });
    } else {
      lines.push({
        register: "system",
        text: `Your camp stands ${where} — sheltered ground; it persists while you camp here.`,
      });
    }
    if (sheltered(state)) lines.push({ register: "survey", text: "The canvas holds over you — you are sheltered." });
  } else {
    lines.push({ register: "system", text: "No camp on this ground. /camp pitch raises one where you stand (consumes a camp kit)." });
  }
  const foreign = state.serverAuthority.placedCamps.filter((camp) => !camp.isOwner && camp.areaId === state.activeAreaId);
  if (foreign.length > 0) {
    lines.push({ register: "receipt", text: `${foreign.length === 1 ? "Another camp" : `${foreign.length} other camps`} on this stretch — not yours to touch.` });
  }
  return lines;
}

/** /camp router — status | pitch | packup (armed). */
export function routeCamp(session: GameSession, confirm: ArmedConfirm, args: readonly string[]): CommandLineOut[] {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "" || sub === "status") return campStatusLines(session.state);
  if (sub === "pitch") return [wire(session, "/place-camp")];
  if (sub === "packup" || sub === "strike") {
    if (confirm.confirm("camp-packup")) return [wire(session, "/pack-up-camp")];
    confirm.arm("camp-packup");
    return [{ register: "system", text: "Striking the camp returns NOTHING to your pack — /camp packup again to confirm." }];
  }
  return [{ register: "system", text: "Camp: /camp shows the ground · /camp pitch raises one at your feet · /camp packup strikes it (nothing returns)." }];
}

function wire(session: GameSession, line: string): CommandLineOut {
  const result = session.executeVerb(line);
  if (!result) return { register: "reject", text: `Nothing answers (${line}).` };
  const rejected = result.class === "authority" && result.data.queued === false;
  return { register: rejected ? "reject" : "receipt", text: result.text };
}
