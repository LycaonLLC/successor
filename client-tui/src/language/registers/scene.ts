/**
 * SCENE register — the world speaking in weather, light and pressure.
 *
 * Fired on login, area change, day-phase change, and weather transitions.
 * Inputs come only from AOI-legal state: area (slice), the projected world
 * clock, streamed weather events, and the contact tracker's counts.
 */

import { BAND_PHRASE, bandFor, type Wind } from "../../game/bearing";
import { pickVariant, type VoiceMemory } from "../voice";

export interface SceneWeather {
  eventType: string;
  phase: "idle" | "warning" | "active" | "decay";
  magnitude: number;
  distanceCells: number;
  wind: Wind;
  inside: boolean;
  /** Player stands inside their own camp's shelter box (shared helper truth). */
  sheltered?: boolean;
}

export interface SceneInputs {
  areaName: string;
  biome: string;
  phase: "deep_night" | "dawn" | "day" | "dusk" | "night";
  moonBrightness: number;
  weather: SceneWeather | null;
  hostiles: number;
  contacts: number;
}

/** Opening line for an area (login / transition): where you stand. */
export function composeArrival(inputs: SceneInputs, memory: VoiceMemory, seed: number): string {
  const place = inputs.areaName.toLowerCase();
  const variants = [
    `You stand in the ${place}. ${lightClause(inputs, memory, seed)}`,
    `The ${place} opens around you. ${lightClause(inputs, memory, seed)}`,
    `This is the ${place}. ${lightClause(inputs, memory, seed)}`,
  ];
  const base = pickVariant(memory, `arrival:${inputs.phase}`, variants, seed);
  return joinClauses(base, weatherClause(inputs.weather, memory, seed), pressureClause(inputs, memory, seed));
}

/** Phase-change beat: the light turning. */
export function composePhaseChange(inputs: SceneInputs, memory: VoiceMemory, seed: number): string {
  const byPhase: Record<SceneInputs["phase"], readonly string[]> = {
    dawn: [
      "Dawn comes up thin and gray, then all at once.",
      "First light crawls across the flats.",
      "The east pales; the cold starts to lose its grip.",
    ],
    day: [
      "The sun climbs to its working height. The light goes hard and flat.",
      "Full day now — heat shimmer stands on the horizon.",
      "Day settles in; every shadow pulls up short.",
    ],
    dusk: [
      "Dusk bleeds out across the sand, long shadows going soft.",
      "The light lowers and goes to rust.",
      "Sundown: the heat lets go of the ground in slow waves.",
    ],
    night: [
      nightMoonLine(inputs, "Night falls."),
      nightMoonLine(inputs, "Dark comes down."),
    ],
    deep_night: [
      "The dead hours. Even the wind walks quietly.",
      "Deep night — the cold owns everything now.",
    ],
  };
  return pickVariant(memory, `phase:${inputs.phase}`, byPhase[inputs.phase], seed);
}

function nightMoonLine(inputs: SceneInputs, lead: string): string {
  if (inputs.moonBrightness > 0.45) return `${lead} The moon is up and generous; the flats hold a gray shine.`;
  if (inputs.moonBrightness > 0.18) return `${lead} A thin moon gives just enough to move by.`;
  return `${lead} No moon worth the name — the dark is total.`;
}

/** Weather transition beats (warning/active/decay/clear). */
export function composeWeatherChange(weather: SceneWeather, memory: VoiceMemory, seed: number): string {
  const name = weatherName(weather.eventType);
  const where = weather.inside
    ? "overhead"
    : `${BAND_PHRASE[bandFor(weather.distanceCells)]} to the ${weather.wind}`;
  switch (weather.phase) {
    case "warning":
      return pickVariant(memory, `weather:warning:${weather.eventType}`, [
        `The air goes still and heavy — ${name} building ${where}.`,
        `Pressure drops. A ${name} is coming, ${where}.`,
        `The horizon smears ${where}: ${name} warning.`,
      ], seed);
    case "active":
      return pickVariant(memory, `weather:active:${weather.eventType}`, weather.inside
        ? (weather.sheltered
          ? [
            `The ${name} breaks over the camp ${strengthClause(weather.magnitude)} — but the canvas holds. You are sheltered.`,
            `Sand and noise take the world outside; under the canvas, the ${name} is just weather.`,
          ]
          : [
            `The ${name} arrives ${strengthClause(weather.magnitude)} — grit hammers everything that stands.`,
            `You are inside the ${name} now; the world narrows to sand and noise.`,
          ])
        : [
          `The ${name} makes ground ${where}, ${strengthClause(weather.magnitude)}.`,
          `A wall of it now — the ${name} is down ${where}.`,
        ], seed);
    case "decay":
      return pickVariant(memory, `weather:decay:${weather.eventType}`, [
        `The ${name} loses its temper, wearing down to gusts.`,
        `The worst of the ${name} passes; the air starts to clear.`,
      ], seed);
    case "idle":
      return pickVariant(memory, `weather:idle:${weather.eventType}`, [
        "The sky settles. Quiet again.",
        "The last of it blows through; the flats go still.",
      ], seed);
  }
}

function lightClause(inputs: SceneInputs, memory: VoiceMemory, seed: number): string {
  const byPhaseBiome: Record<string, readonly string[]> = {
    "day:desert": [
      "The light is hard and flat, heat standing on the sand.",
      "Sun straight overhead; the ground throws the heat back up at you.",
    ],
    "dawn:desert": ["First light lies long and red across the flats."],
    "dusk:desert": ["The last light goes to rust along the ridgelines."],
    "night:desert": ["The cold comes up out of the ground with the dark."],
    "deep_night:desert": ["The dead hours; the cold is a physical thing."],
    "day:forest": ["Light falls in broken coins through the canopy."],
    "night:forest": ["Under the trees the dark is layered and close."],
  };
  const generic: Record<SceneInputs["phase"], readonly string[]> = {
    day: ["The light is full and even."],
    dawn: ["Dawn light, thin and improving."],
    dusk: ["The light is lowering."],
    night: ["It is night, and quiet."],
    deep_night: ["It is the dead of night."],
  };
  const variants = byPhaseBiome[`${inputs.phase}:${inputs.biome}`] ?? generic[inputs.phase];
  return pickVariant(memory, `light:${inputs.phase}:${inputs.biome}`, variants, seed);
}

function weatherClause(weather: SceneWeather | null, memory: VoiceMemory, seed: number): string | null {
  if (!weather || weather.phase === "idle") return null;
  const name = weatherName(weather.eventType);
  if (weather.phase === "warning") {
    return `A ${name} is building ${BAND_PHRASE[bandFor(weather.distanceCells)]} to the ${weather.wind}.`;
  }
  if (weather.inside) {
    return weather.sheltered
      ? `A ${name} is on the ground outside, ${strengthClause(weather.magnitude)} — the canvas holds over you.`
      : `You are inside a ${name}, ${strengthClause(weather.magnitude)}.`;
  }
  return pickVariant(memory, "scene:weather", [
    `A ${name} works the ground to the ${weather.wind}.`,
    `Off to the ${weather.wind}, a ${name} drags its skirt across the flats.`,
  ], seed);
}

function pressureClause(inputs: SceneInputs, memory: VoiceMemory, seed: number): string | null {
  if (inputs.hostiles > 1) {
    return pickVariant(memory, "scene:pressure", [
      `${countWord(inputs.hostiles)} hostiles share this ground with you.`,
      `You are not alone out here — ${countWord(inputs.hostiles)} hostiles in scope.`,
    ], seed);
  }
  if (inputs.hostiles === 1) return "One hostile shares this ground with you.";
  if (inputs.contacts === 0) return "Nothing moves in scope.";
  return null;
}

function weatherName(eventType: string): string {
  const names: Record<string, string> = {
    sandstorm: "sandstorm",
    duststorm: "dust storm",
    storm: "storm",
  };
  return names[eventType] ?? eventType.replace(/[-_]/g, " ");
}

function strengthClause(magnitude: number): string {
  if (magnitude >= 0.75) return "and it means it";
  if (magnitude >= 0.4) return "carrying real weight";
  return "light but insistent";
}

function countWord(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return n >= 0 && n < words.length ? words[n]! : String(n);
}

function joinClauses(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join(" ");
}
