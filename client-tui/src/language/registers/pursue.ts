/**
 * PURSUE register — the approach spoken.
 *
 * Beats arrive from the pursue machine ONLY on state change (start, level
 * off, re-pursue, abort) — steady walking is silent, so the register can
 * afford a full sentence per beat. Same voice rules as every register:
 * second person, concrete distances, seeded no-repeat variation, honest
 * reasons. Lines ride the combat ink — the approach belongs to the fight.
 */

import type { PursueBeat } from "../../game/pursue";
import { pickVariant, type VoiceMemory } from "../voice";
import { cap, subjectName } from "./world";

export interface PursueLine {
  register: string;
  text: string;
}

export function composePursueBeat(beat: PursueBeat, memory: VoiceMemory, seed: number): PursueLine | null {
  const name = subjectName(beat.label);
  switch (beat.kind) {
    case "start": {
      const d = Math.round(beat.dCells);
      if (beat.band.melee) {
        return line(pickVariant(memory, "pursue:start:melee", [
          `You go for ${name} — ${d}c to close, weapon ready.`,
          `You move on ${name}, closing to arm's reach — ${d}c to cover.`,
          `${cap(name)} is ${d}c off; you start the walk with steel out.`,
        ], seed));
      }
      const band = beat.band.desiredCells;
      return line(pickVariant(memory, "pursue:start:ranged", [
        `You move on ${name} — ${d}c out, closing to the gun's ${band}c band.`,
        `You push toward ${name}, walking the ${d}c gap down to firing range.`,
        `Boots forward: ${name} stands ${d}c off, and the gun wants ${band}c.`,
      ], seed));
    }
    case "level_off": {
      const d = Math.round(beat.dCells);
      if (beat.band.melee) {
        return line(pickVariant(memory, "pursue:level:melee", [
          `You close to reach and square up on ${name}.`,
          `In reach — you step inside ${name}'s guard.`,
          `You shut the last stride and bring the edge around.`,
        ], seed));
      }
      return line(pickVariant(memory, "pursue:level:ranged", [
        `You level off at ${d}c — the band is good — and bring the weapon up.`,
        `Range. You plant your feet at ${d}c and take the shot line.`,
        `You stop where the gun likes it, ${d}c out, and open up.`,
      ], seed));
    }
    case "repursue": {
      const d = Math.round(beat.dCells);
      return line(pickVariant(memory, "pursue:repursue", [
        `${cap(name)} opens the gap — you take up the chase again (${d}c).`,
        `The range breaks; you push after ${name}, ${d}c to make back.`,
        `${cap(name)} gives ground. You follow, closing again.`,
      ], seed));
    }
    case "abort":
      return composeAbort(beat, name, memory, seed);
  }
}

function composeAbort(
  beat: Extract<PursueBeat, { kind: "abort" }>,
  name: string,
  memory: VoiceMemory,
  seed: number,
): PursueLine | null {
  switch (beat.reason) {
    case "target_dead":
      return line(pickVariant(memory, "pursue:abort:dead", [
        `${cap(name)} drops before you get there — you ease off.`,
        `Your quarry is down before you close. You let the walk die.`,
      ], seed));
    case "target_lost":
      return line(pickVariant(memory, "pursue:abort:lost", [
        `You lose ${name} from your scope — the pursuit dies with the signal.`,
        `${cap(name)} passes out of scope; nothing left to walk at.`,
      ], seed));
    case "player_move":
    case "player_command":
      return line(pickVariant(memory, "pursue:abort:player", [
        "You break off the approach.",
        "You let the pursuit go.",
      ], seed));
    case "budget":
      return reject(pickVariant(memory, "pursue:abort:budget", [
        "You pull up short — the wire won't carry the pace.",
        "The wire chokes on your stride; you halt where you stand.",
      ], seed));
    case "timeout":
      return line(pickVariant(memory, "pursue:abort:timeout", [
        `The chase runs long and you call it — ${name} keeps the distance.`,
        `You give up the ground game; ${name} won't be caught today.`,
      ], seed));
    case "attack_denied":
      return line(pickVariant(memory, "pursue:abort:denied", [
        "The attack dies in your hands — you stand down.",
        "No shot there. You let the approach go.",
      ], seed));
    case "too_far": {
      const d = beat.dCells !== undefined ? ` — ${Math.round(beat.dCells)}c out` : "";
      return reject(`${cap(name)} is beyond a sane walk${d}. Close some ground first.`);
    }
    case "hurt":
      return reject(pickVariant(memory, "pursue:abort:hurt", [
        "You take a hit and pull up — no sense walking into it.",
        "Blood on the move — you break off before it gets worse.",
      ], seed));
  }
}

function line(text: string): PursueLine {
  return { register: "combat", text };
}

function reject(text: string): PursueLine {
  return { register: "reject", text };
}
