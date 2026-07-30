/**
 * Narrator — SessionEvents + polled state in, spoken lines out.
 *
 * The one place where game signals meet the registers. Owns the voice
 * memory, the rate gates, and the transition detectors (day phase, weather
 * phase, area change, death). Every line carries its register so the log
 * can ink it and --plain can print it, identically.
 */

import { currentArea } from "@successor/client/src/slice-core/worldQueries";
import { projectedWorldClockState } from "@successor/client/src/slice-core/worldClockSystem";
import type { PlayState } from "@successor/client/src/slice-core/gameState";

import { bandFor, windFor } from "../game/bearing";
import { sheltered } from "../game/camp";
import type { GameSession, SessionEvent } from "../game/session";
import { composeReceiptLine } from "./registers/receipts";
import {
  composeArrival,
  composePhaseChange,
  composeWeatherChange,
  type SceneInputs,
  type SceneWeather,
} from "./registers/scene";
import { composeSampleLine, composeSurveyLine } from "./registers/survey";
import {
  composeArrivalLine,
  composeAttitudeShift,
  composeCorpseLootable,
  composeDepartureLine,
  composeGroupArrivalLine,
} from "./registers/world";
import { abilityLabel, reasonCopy } from "./copy";
import { createRateGate, createVoiceMemory, rateGateAllows } from "./voice";

export interface LogLine {
  register: string;
  text: string;
  atMs: number;
}

export interface NarratorOptions {
  verbose?: boolean;
  now?: () => number;
  /** Speak chat lines into the log (plain mode); the TUI routes chat to its pane. */
  chatLines?: boolean;
  /** Receipt kinds another surface phrases (live /converse persona voice). */
  suppressReceipt?: (kind: string | undefined) => boolean;
}

export interface Narrator {
  /** Subscribe to the session; returns the unsubscribe. */
  attach(): () => void;
  /** Transition detectors — call on a coarse cadence (~500ms). */
  poll(): void;
  /** Full scene block on demand (login, /look, area change). */
  look(): void;
}

export function createNarrator(session: GameSession, sink: (line: LogLine) => void, options: NarratorOptions = {}): Narrator {
  const memory = createVoiceMemory();
  const gate = createRateGate();
  const now = options.now ?? Date.now;
  const chatLines = options.chatLines !== false;

  let lastPhase: string | null = null;
  let lastAreaId: string | null = null;
  let lastDeathPhase = "alive";
  const weatherPhases = new Map<string, string>();

  const say = (register: string, text: string | null): void => {
    if (!text || text.length === 0) return;
    sink({ register, text, atMs: now() });
  };

  const seed = (): number => session.estimatedTick();

  const sceneInputs = (): SceneInputs => {
    const state = session.state;
    const area = currentArea(session.slice, state);
    const clock = projectedWorldClockState(state.worldClock, state.worldTimeMs);
    return {
      areaName: area.name,
      biome: area.biome ?? "desert",
      phase: clock.phase,
      moonBrightness: clock.moon.brightness,
      weather: activeWeather(state),
      hostiles: session.tracker.hostileCount(),
      contacts: session.tracker.contacts().length,
    };
  };

  const onEvent = (event: SessionEvent): void => {
    switch (event.kind) {
      case "receipt": {
        if (options.suppressReceipt?.(event.commandKind)) return;
        const line = composeReceiptLine({
          commandKind: event.commandKind,
          accepted: event.accepted,
          reasonCode: event.reasonCode,
        });
        if (line) say(line.reject ? "reject" : "receipt", line.text);
        // The 30s autosample-cooldown ruling: sampler cooldown rejects speak once per window.
        if (event.accepted && event.commandKind === "SampleResource") pendingSample = true;
        return;
      }
      case "combat": {
        // Handled by CombatNarratorReducer in app.ts / plain.ts
        return;
      }
      case "queue": {
        if (event.event.lifecycle === "dismissed" && event.event.reasonCode) {
          const label = event.event.abilityId ? abilityLabel(event.event.abilityId) : "queued action";
          say("reject", `Your ${label} is dismissed — ${reasonCopy(event.event.reasonCode)}.`);
        }
        return;
      }
      case "survey": {
        const state = session.state;
        const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
        say("survey", composeSurveyLine({
          family: event.result.family,
          spawnName: event.result.spawnName,
          centerX: event.result.centerX,
          centerY: event.result.centerY,
          rangeCells: event.result.rangeCells,
          stepCells: event.result.stepCells,
          cols: event.result.cols,
          rows: event.result.rows,
          concentrationMilli: event.result.concentrationMilli,
          playerX: me?.x ?? state.player.x,
          playerY: me?.y ?? state.player.y,
        }, memory, seed()));
        return;
      }
      case "contacts": {
        narrateContacts(event);
        return;
      }
      case "status": {
        narrateStatus(event.status, event.message);
        return;
      }
      case "chat": {
        if (!chatLines) return;
        if (event.message.system) {
          say("system", event.message.body);
        } else {
          const tag = event.message.channel === "whisper" ? "whisper" : event.message.channel;
          say("chat", `[${tag}] ${event.message.sender.displayName}: ${event.message.body}`);
        }
        return;
      }
      case "system": {
        say("system", event.text);
        return;
      }
    }
  };

  let pendingSample = false;

  const narrateContacts = (event: Extract<SessionEvent, { kind: "contacts" }>): void => {
    const { arrivals, departures, attitudeShifts, corpses } = event.events;
    // arrivals: hostiles always speak; others rate-gated; crowds coalesce
    if (arrivals.length >= 3) {
      say("world", composeGroupArrivalLine(arrivals.map((contact) => ({
        label: contact.label,
        relation: contact.relation,
        dx: contact.dx,
        dy: contact.dy,
        inCombat: contact.inCombat,
      })), memory, seed()));
    } else {
      for (const contact of arrivals) {
        const urgent = contact.relation === "hostile";
        if (!urgent && !rateGateAllows(gate, "arrive", now(), 1_500)) continue;
        say("world", composeArrivalLine({
          label: contact.label,
          descriptor: contact.descriptor,
          relation: contact.relation,
          dx: contact.dx,
          dy: contact.dy,
          inCombat: contact.inCombat,
        }, memory, seed()));
      }
    }
    for (const departure of departures) {
      if (!rateGateAllows(gate, "depart", now(), 2_000)) break;
      say("world", composeDepartureLine(departure, memory, seed()));
    }
    for (const shift of attitudeShifts) {
      say("world", composeAttitudeShift(shift.label, shift.to, memory, seed()));
    }
    for (const corpse of corpses) {
      say("loot", composeCorpseLootable(corpse.label, corpse.mine, memory, seed()));
    }
  };

  const narrateStatus = (status: string, message?: string): void => {
    const lines: Record<string, string> = {
      booting: "Bringing the field kit up…",
      connecting: "Raising the shard…",
      ready: "Signal locked. You are in the world.",
      disconnected: "The wire goes dead — connection lost.",
      closed: "You fold the terminal shut.",
      not_ready: "The wire is not up yet.",
    };
    const text = lines[status] ?? (message ? `${status}: ${message}` : null);
    if (status === "error") {
      say("reject", message ? `Trouble on the wire — ${message}` : "Trouble on the wire.");
      return;
    }
    say("system", text);
  };

  return {
    attach() {
      return session.onEvent(onEvent);
    },
    poll() {
      const state = session.state;
      // sample outcome: the accepted sampler receipt's yield surfaces as prose
      if (pendingSample && sampleLanded(state)) {
        pendingSample = false;
        say("survey", composeSampleLine({ family: "metal", quantity: null, itemLabel: null }, memory, seed()));
      }
      // area change
      if (state.activeAreaId !== lastAreaId) {
        lastAreaId = state.activeAreaId;
        lastPhase = projectedWorldClockState(state.worldClock, state.worldTimeMs).phase;
        say("scene", composeArrival(sceneInputs(), memory, seed()));
        return;
      }
      // day-phase turn
      const clock = projectedWorldClockState(state.worldClock, state.worldTimeMs);
      if (lastPhase !== null && clock.phase !== lastPhase) {
        say("scene", composePhaseChange(sceneInputs(), memory, seed()));
      }
      lastPhase = clock.phase;
      // weather phase transitions
      for (const weather of state.weather) {
        if (weather.areaId !== state.activeAreaId) continue;
        const key = `${weather.areaId}:${weather.eventType}`;
        const prior = weatherPhases.get(key);
        if (prior !== weather.phase) {
          weatherPhases.set(key, weather.phase);
          if (prior !== undefined || weather.phase !== "idle") {
            say("scene", composeWeatherChange(sceneWeatherOf(state, weather), memory, seed()));
          }
        }
      }
      // death phase
      if (state.death.phase !== lastDeathPhase) {
        if (state.death.phase === "downed") say("combat", "You are down. The world tilts sideways and waits.");
        if (state.death.phase === "clone_pending") say("system", "Clone activation available — /clone when you are ready.");
        if (state.death.phase === "alive" && lastDeathPhase !== "alive") say("system", "You are on your feet again.");
        lastDeathPhase = state.death.phase;
      }
    },
    look() {
      lastAreaId = session.state.activeAreaId;
      lastPhase = projectedWorldClockState(session.state.worldClock, session.state.worldTimeMs).phase;
      say("scene", composeArrival(sceneInputs(), memory, seed()));
      const contacts = session.tracker.contacts();
      for (const contact of contacts.slice(0, 3)) {
        if (contact.relation !== "hostile") continue;
        const subject = contact.descriptor ? `${contact.label}, ${contact.descriptor}` : contact.label;
        say("world", `${subject} — hostile, ${Math.round(contact.dCells)}c ${windFor(contact.dx, contact.dy)}.`);
      }
      const interactions = session.state.interactions.options;
      if (interactions.length > 0) {
        const heads = interactions.slice(0, 3).map((option) => option.label.toLowerCase());
        say("system", `You could: ${heads.join(" · ")}.`);
      }
    },
  };

  function activeWeather(state: PlayState): SceneWeather | null {
    let best: SceneWeather | null = null;
    let bestRank = -1;
    const rank: Record<string, number> = { active: 3, warning: 2, decay: 1, idle: 0 };
    for (const weather of state.weather) {
      if (weather.areaId !== state.activeAreaId) continue;
      const r = rank[weather.phase] ?? 0;
      if (r > bestRank) {
        bestRank = r;
        best = sceneWeatherOf(state, weather);
      }
    }
    return best && best.phase !== "idle" ? best : null;
  }

  function sceneWeatherOf(state: PlayState, weather: PlayState["weather"][number]): SceneWeather {
    const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
    const px = me?.x ?? state.player.x;
    const py = me?.y ?? state.player.y;
    const dx = weather.centerX - px;
    const dy = weather.centerY - py;
    const distance = Math.hypot(dx, dy);
    return {
      eventType: weather.eventType,
      phase: weather.phase,
      magnitude: weather.magnitude,
      distanceCells: Math.max(0, distance - weather.radiusCells),
      wind: windFor(dx, dy),
      inside: distance <= weather.radiusCells,
      sheltered: sheltered(state),
    };
  }

  function sampleLanded(_state: PlayState): boolean {
    return true;
  }
}

export { bandFor };
