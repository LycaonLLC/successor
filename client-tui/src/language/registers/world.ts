/**
 * WORLD register — comings, goings, and the ground changing state.
 *
 * Every line here is an AOI truth: an actor entered/left the streamed set,
 * an attitude hardened, a corpse opened for looting, a door moved. The
 * contact tracker feeds these; the composer only turns them into speech.
 */

import { bearingPhrase, windFor, type Wind } from "../../game/bearing";
import { pickVariant, type VoiceMemory } from "../voice";

export type ContactRelation = "hostile" | "alerted" | "civilian";

export interface ArrivalEvent {
  label: string;
  descriptor?: string;
  relation: ContactRelation;
  dx: number;
  dy: number;
  inCombat: boolean;
}

export interface DepartureEvent {
  label: string;
  lastDx: number;
  lastDy: number;
}

export function composeArrivalLine(event: ArrivalEvent, memory: VoiceMemory, seed: number): string {
  const where = bearingPhrase(event.dx, event.dy);
  const name = subjectWithType(event.label, event.descriptor);
  if (event.relation === "hostile") {
    const armed = event.inCombat ? ", weapon drawn" : "";
    return pickVariant(memory, "arrive:hostile", [
      `${cap(name)} comes into scope, ${where}${armed}.`,
      `${cap(name)} crests into view ${where}${armed}.`,
      `Movement — ${name}, ${where}${armed}.`,
    ], seed);
  }
  if (event.relation === "alerted") {
    return pickVariant(memory, "arrive:alerted", [
      `${cap(name)} appears ${where}, head up, watching.`,
      `${cap(name)} edges into scope ${where}, wary.`,
    ], seed);
  }
  return pickVariant(memory, "arrive:civilian", [
    `${cap(name)} wanders into scope, ${where}.`,
    `${cap(name)} passes through, ${where}.`,
  ], seed);
}

/** Multiple arrivals in one breath — coalesced by the tracker. */
export function composeGroupArrivalLine(events: readonly ArrivalEvent[], memory: VoiceMemory, seed: number): string {
  const hostiles = events.filter((event) => event.relation === "hostile");
  const lead = hostiles[0] ?? events[0]!;
  const where = bearingPhrase(lead.dx, lead.dy);
  if (hostiles.length >= 2) {
    return pickVariant(memory, "arrive:group-hostile", [
      `${countWord(hostiles.length)} hostiles come into scope together, ${where}.`,
      `A knot of hostiles — ${countWord(hostiles.length)} — moves in ${where}.`,
    ], seed);
  }
  return `${countWord(events.length)} figures drift into scope, ${where}.`;
}

export function composeDepartureLine(event: DepartureEvent, memory: VoiceMemory, seed: number): string {
  const wind = windFor(event.lastDx, event.lastDy);
  return pickVariant(memory, "depart", [
    `${cap(subjectName(event.label))} slips out of scope to the ${wind}.`,
    `${cap(subjectName(event.label))} drops off your scope, ${wind}ward.`,
    `You lose ${subjectName(event.label)} to the ${wind}.`,
  ], seed);
}

export function composeAttitudeShift(label: string, to: ContactRelation, memory: VoiceMemory, seed: number): string | null {
  const name = subjectName(label);
  if (to === "hostile") {
    return pickVariant(memory, "attitude:hostile", [
      `${cap(name)} levels a weapon at you.`,
      `${cap(name)} turns on you, hostile now.`,
    ], seed);
  }
  if (to === "alerted") {
    return pickVariant(memory, "attitude:alerted", [
      `${cap(name)} stiffens — you have been noticed.`,
      `${cap(name)} marks you and holds still.`,
    ], seed);
  }
  return null;
}

export function composeCorpseLootable(label: string, mine: boolean, memory: VoiceMemory, seed: number): string {
  const name = subjectName(label);
  if (mine) {
    return pickVariant(memory, "corpse:mine", [
      `The body of ${name} is yours to strip.`,
      `${cap(name)} is down for good; the salvage is yours.`,
    ], seed);
  }
  return `${cap(name)} is down; the claim on the body is not yours.`;
}

export function composeDoorLine(label: string, open: boolean): string {
  return open ? `The ${label.toLowerCase()} stands open.` : `The ${label.toLowerCase()} swings shut.`;
}

/** "Dax Vale, a rogue drifter" — the earlier sandbox design intro read: proper name + type line.
 *  Falls back to the bare subjectName when there is no descriptor. */
function subjectWithType(label: string, descriptor?: string | null): string {
  const base = subjectName(label);
  const type = descriptor?.trim();
  return type ? `${base}, ${type}` : base;
}

function subjectName(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return "something";
  // Named characters keep their capital; generic roles get an article.
  if (/^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/.test(trimmed) && !/(trooper|raider|drifter|pawn|guard|vendor|trainer)/i.test(trimmed)) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  return /^[aeiou]/.test(lower) ? `an ${lower}` : `a ${lower}`;
}

function cap(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function countWord(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return n >= 0 && n < words.length ? words[n]! : String(n);
}

export { subjectName, subjectWithType, cap };
export type { Wind };
