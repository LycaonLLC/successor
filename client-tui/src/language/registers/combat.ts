/**
 * COMBAT register — the fight, narrated from authoritative events only.
 *
 * Input is the streamed combat event (roll model: hit/miss/dodge/shield +
 * lifecycle beats), already deduped by the session layer. Perspective is
 * grammatical: you/yours for the owning session, names for everyone else.
 * `verbose` appends the roll arithmetic for players who want the dice.
 */

import { ZONE_PHRASE } from "../copy";
import { pickVariant, type VoiceMemory } from "../voice";
import { cap, subjectName } from "./world";

export interface CombatEventInputs {
  shooterId: string;
  targetId: string;
  shooterLabel: string;
  targetLabel: string;
  meId: string;
  hit: boolean | undefined;
  damage: number;
  zone: string;
  actionId: string | undefined;
  effectKind: "dodge" | "shield" | "sleep" | undefined;
  lifecycleKind: "hit" | "downed" | "killed" | undefined;
  rollMilli: number | undefined;
  toHitMilli: number | undefined;
  verbose: boolean;
}

export function composeCombatLine(event: CombatEventInputs, memory: VoiceMemory, seed: number): string | null {
  const meShooting = event.shooterId === event.meId;
  const meHit = event.targetId === event.meId;
  const roll = event.verbose && event.rollMilli !== undefined && event.toHitMilli !== undefined
    ? `  (roll ${event.rollMilli} v ${event.toHitMilli})`
    : "";

  // Lifecycle beats outrank everything: a kill is a kill.
  if (event.lifecycleKind === "killed") return `${killedLine(event, memory, seed)}${roll}`;
  if (event.lifecycleKind === "downed") return `${downedLine(event, memory, seed)}${roll}`;

  if (event.effectKind === "dodge") {
    if (meShooting) {
      return pickVariant(memory, "combat:dodge:out", [
        `${cap(subjectName(event.targetLabel))} reads your shot and slides off the line.`,
        `Your shot forces ${subjectName(event.targetLabel)} to dive — no contact.`,
      ], seed) + roll;
    }
    if (meHit) {
      return pickVariant(memory, "combat:dodge:in", [
        "You feel the round coming and roll off the line — clean dodge.",
        "You throw yourself aside; the shot cuts empty air.",
      ], seed) + roll;
    }
    return null;
  }

  if (event.effectKind === "shield") {
    if (meHit) return "Your shield takes the hit and holds, whining.";
    if (meShooting) return `${cap(subjectName(event.targetLabel))}'s shield soaks your round in a spray of light.`;
    return null;
  }

  if (event.effectKind === "sleep") {
    if (meHit) return "The dart bites — the world goes thick and slow.";
    if (meShooting) return `Your dart takes ${subjectName(event.targetLabel)}; they sway on their feet.`;
    return null;
  }

  if (event.hit === false) {
    if (meShooting) {
      return pickVariant(memory, "combat:miss:out", [
        `Your shot goes wide of ${subjectName(event.targetLabel)}.`,
        `You rush it — the round kicks dust past ${subjectName(event.targetLabel)}.`,
        `Miss. ${cap(subjectName(event.targetLabel))} is still coming.`,
      ], seed) + roll;
    }
    if (meHit) {
      return pickVariant(memory, "combat:miss:in", [
        `${cap(subjectName(event.shooterLabel))} fires and misses; the round snaps past your ear.`,
        `A shot from ${subjectName(event.shooterLabel)} kicks sand at your feet.`,
      ], seed) + roll;
    }
    return null;
  }

  // A landed hit.
  const zone = ZONE_PHRASE[event.zone] ?? "somewhere it counts";
  const dmg = event.damage > 0 ? ` — ${event.damage}` : "";
  if (meShooting) {
    return pickVariant(memory, "combat:hit:out", [
      `Your shot takes ${subjectName(event.targetLabel)} ${zone}${dmg}.`,
      `You put a round into ${subjectName(event.targetLabel)}, ${zone}${dmg}.`,
      `Clean hit — ${subjectName(event.targetLabel)}, ${zone}${dmg}.`,
    ], seed) + roll;
  }
  if (meHit) {
    return pickVariant(memory, "combat:hit:in", [
      `${cap(subjectName(event.shooterLabel))}'s shot catches you ${zone}${dmg}.`,
      `You take a round ${zone}${dmg} — ${subjectName(event.shooterLabel)}'s work.`,
    ], seed) + roll;
  }
  // Third-party fire only whispers (keeps the log yours).
  return pickVariant(memory, "combat:hit:third", [
    `${cap(subjectName(event.shooterLabel))} trades fire with ${subjectName(event.targetLabel)}.`,
  ], seed);
}

function downedLine(event: CombatEventInputs, memory: VoiceMemory, seed: number): string {
  if (event.targetId === event.meId) {
    return pickVariant(memory, "combat:downed:me", [
      "Your legs go out from under you. You are DOWN.",
      "The ground comes up hard — you are DOWN, bleeding into the sand.",
    ], seed);
  }
  const name = subjectName(event.targetLabel);
  if (event.shooterId === event.meId) {
    return pickVariant(memory, "combat:downed:out", [
      `Your shot folds ${name} — down and not getting up easily.`,
      `${cap(name)} drops under your fire.`,
    ], seed);
  }
  return `${cap(name)} goes down.`;
}

function killedLine(event: CombatEventInputs, memory: VoiceMemory, seed: number): string {
  if (event.targetId === event.meId) {
    return "Everything goes white, then nothing. You are dead.";
  }
  const name = subjectName(event.targetLabel);
  if (event.shooterId === event.meId) {
    return pickVariant(memory, "combat:killed:out", [
      `${cap(name)} drops, and does not move again.`,
      `Your round finishes it — ${name} is dead.`,
      `Down and still. ${cap(name)} is done.`,
    ], seed);
  }
  return `${cap(name)} is killed.`;
}

/** FIRED beat for the owning session's queue (spec §F): terse, present. */
export function composeFiredLine(abilityId: string, targetLabel: string | null): string {
  const action: Record<string, string> = {
    basic_shot: "You fire",
    aimed_shot: "You take the long breath and fire",
    melee_strike: "You swing",
  };
  const verb = action[abilityId] ?? "You act";
  return targetLabel ? `${verb} on ${subjectName(targetLabel)}.` : `${verb}.`;
}
