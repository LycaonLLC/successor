/**
 * Combat Narrator & Reducer.
 *
 * Consumes raw combat events (`GameCombatEvent`) from authority/session wire envelopes.
 * Emits pure, deterministic prose lines for log panes across both TUI modes (--plain and full-screen).
 *
 * Supports duplicate event suppression, hit/miss/dodge/shield,
 * downed/killed, and unknown-event fail-closed behavior.
 */

import { ZONE_PHRASE } from "../language/copy";
import type { LogLine } from "../language/narrator";
import { pickVariant, createVoiceMemory, type VoiceMemory } from "../language/voice";
import { cap, subjectName } from "../language/registers/world";
import type { PlayState } from "@successor/client/src/slice-core/gameState";

export interface ReducedCombatInputs {
  id: number | undefined;
  seq: number | undefined;
  tick: number | undefined;
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

const DEDUP_HISTORY_LIMIT = 64;

export class CombatNarratorReducer {
  private readonly memory: VoiceMemory = createVoiceMemory();
  private readonly recentKeys: string[] = [];
  private readonly keySet = new Set<string>();

  reset(): void {
    this.recentKeys.length = 0;
    this.keySet.clear();
  }

  reduce(state: PlayState, raw: Record<string, unknown>, verbose = false): ReducedCombatInputs {
    const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const shooterId = String(raw.shooterActorId ?? "");
    const targetId = String(raw.targetActorId ?? "");
    const effectKind = nestedKind(raw.effect);
    const lifecycleKind = nestedKind(raw.lifecycle);
    const damage = typeof raw.damage === "number" ? Math.max(0, raw.damage) : 0;

    return {
      id: typeof raw.id === "number" ? raw.id : undefined,
      seq: typeof raw.seq === "number" ? raw.seq : undefined,
      tick: typeof raw.tick === "number" ? raw.tick : undefined,
      shooterId,
      targetId,
      shooterLabel: labelFor(state, shooterId),
      targetLabel: labelFor(state, targetId),
      meId,
      hit: typeof raw.hit === "boolean" ? raw.hit : undefined,
      damage,
      zone: String(raw.zone ?? "torso"),
      actionId: typeof raw.actionId === "string" ? raw.actionId : undefined,
      effectKind: effectKind === "dodge" || effectKind === "shield" || effectKind === "sleep" ? effectKind : undefined,
      lifecycleKind: lifecycleKind === "hit" || lifecycleKind === "downed" || lifecycleKind === "killed" ? lifecycleKind : undefined,
      rollMilli: typeof raw.rollMilli === "number" ? raw.rollMilli : undefined,
      toHitMilli: typeof raw.toHitMilli === "number" ? raw.toHitMilli : undefined,
      verbose,
    };
  }

  ingest(state: PlayState, raw: Record<string, unknown>, verbose = false, nowMs = Date.now()): LogLine[] {
    if (!raw || typeof raw !== "object") return [];

    const inputs = this.reduce(state, raw, verbose);
    const key = makeDedupKey(inputs);

    if (this.keySet.has(key)) {
      return [];
    }

    this.keySet.add(key);
    this.recentKeys.push(key);
    if (this.recentKeys.length > DEDUP_HISTORY_LIMIT) {
      const oldest = this.recentKeys.shift();
      if (oldest) this.keySet.delete(oldest);
    }

    const lines: LogLine[] = [];
    const seed = inputs.tick ?? 0;

    const mainProse = composeCombatLine(inputs, this.memory, seed);
    if (mainProse) {
      lines.push({ register: "combat", text: mainProse, atMs: nowMs });
    }

    return lines;
  }
}

function nestedKind(value: unknown): string | null {
  if (value && typeof value === "object" && "kind" in value) {
    const k = (value as Record<string, unknown>).kind;
    return typeof k === "string" ? k : null;
  }
  if (typeof value === "string") return value;
  return null;
}

function labelFor(state: PlayState, actorId: string): string {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  if (actorId === meId) return "you";
  const known = state.serverAuthority.actors[actorId]?.label;
  if (known && known.trim().length > 0) return known;

  // Fail closed without leaking opaque IDs into player copy
  return "an operative";
}

function makeDedupKey(inputs: ReducedCombatInputs): string {
  if (inputs.id !== undefined) {
    return `id:${inputs.id}`;
  }
  if (inputs.seq !== undefined) {
    return `seq:${inputs.seq}`;
  }
  return [
    inputs.tick ?? 0,
    inputs.shooterId,
    inputs.targetId,
    inputs.lifecycleKind ?? "",
    inputs.effectKind ?? "",
    inputs.hit ?? "",
    inputs.damage,
    inputs.zone,
  ].join(":");
}

export function composeCombatLine(event: ReducedCombatInputs, memory: VoiceMemory, seed: number): string | null {
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
  if (event.hit === true || event.damage > 0 || event.lifecycleKind === "hit") {
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

  // Unknown or unhandled event shape -> fail closed (silent).
  return null;
}

function downedLine(event: ReducedCombatInputs, memory: VoiceMemory, seed: number): string {
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

function killedLine(event: ReducedCombatInputs, memory: VoiceMemory, seed: number): string {
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
