/**
 * Contact tracker — the radar's data source with a memory.
 *
 * Classification is the 3D radar contract verbatim: `aiAttitude` first,
 * faction-vs-me fallback; civilians drop beyond scope radius while
 * hostile/alerted rim-clamp. On top of the per-frame snapshot the tracker
 * diffs AOI presence into EVENTS — arrivals, departures, attitude shifts,
 * corpse-lootable beats — which the world register turns into prose.
 */

import type { PlayState, ServerAuthorityActorState } from "@successor/client/src/slice-core/gameState";
import { RADAR_RADIUS_CELLS } from "./bearing";
import type { ContactRelation } from "../language/registers/world";

export interface Contact {
  id: string;
  label: string;
  /** actor descriptor ("a rogue drifter"); server-authoritative, absent for players. */
  descriptor?: string;
  relation: ContactRelation;
  x: number;
  y: number;
  dx: number;
  dy: number;
  dCells: number;
  rimClamped: boolean;
  inCombat: boolean;
}

export interface ContactEvents {
  arrivals: Contact[];
  departures: Array<{ id: string; label: string; lastDx: number; lastDy: number }>;
  attitudeShifts: Array<{ id: string; label: string; to: ContactRelation }>;
  corpses: Array<{ id: string; label: string; mine: boolean }>;
}

interface TrackedContact {
  label: string;
  relation: ContactRelation;
  dx: number;
  dy: number;
}

export interface ContactTracker {
  /** Recompute the visible set; returns the events since the last update. */
  update(state: PlayState): ContactEvents;
  /** Current visible contacts, nearest first. */
  contacts(): readonly Contact[];
  hostileCount(): number;
}

export function createContactTracker(): ContactTracker {
  const tracked = new Map<string, TrackedContact>();
  const knownCorpses = new Set<string>();
  let visible: Contact[] = [];

  return {
    update(state) {
      const events: ContactEvents = { arrivals: [], departures: [], attitudeShifts: [], corpses: [] };
      const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
      const me = state.serverAuthority.actors[meId];
      const px = me?.x ?? state.player.x;
      const py = me?.y ?? state.player.y;
      const areaId = me?.areaId ?? state.activeAreaId;

      visible = [];
      const seen = new Set<string>();
      for (const actorId in state.serverAuthority.actors) {
        if (actorId === meId) continue;
        const actor = state.serverAuthority.actors[actorId];
        if (!actor || actor.areaId !== areaId) continue;

        // Corpse beats: lootable flag turning true while the body still has loot.
        if (actor.lifeState !== "alive") {
          if (actor.lootable && actor.hasLoot && !knownCorpses.has(actorId)) {
            knownCorpses.add(actorId);
            const rights = actor.lootRightsActorId ?? null;
            events.corpses.push({ id: actorId, label: actor.label, mine: rights === null || rights === meId });
          }
          continue;
        }
        knownCorpses.delete(actorId);

        const relation = relationFor(actor, me);
        const dx = actor.x - px;
        const dy = actor.y - py;
        const dCells = Math.hypot(dx, dy);
        const rimClamped = dCells > RADAR_RADIUS_CELLS;
        if (rimClamped && relation === "civilian") continue; // radar contract: civilians drop beyond scope

        seen.add(actorId);
        visible.push({
          id: actorId,
          label: actor.label,
          descriptor: actor.descriptor,
          relation,
          x: actor.x,
          y: actor.y,
          dx,
          dy,
          dCells,
          rimClamped,
          inCombat: actor.inCombat === true,
        });

        const prior = tracked.get(actorId);
        if (!prior) {
          const contact = visible[visible.length - 1]!;
          events.arrivals.push(contact);
          tracked.set(actorId, { label: actor.label, relation, dx, dy });
        } else {
          if (prior.relation !== relation && (relation === "hostile" || relation === "alerted")) {
            events.attitudeShifts.push({ id: actorId, label: actor.label, to: relation });
          }
          prior.relation = relation;
          prior.dx = dx;
          prior.dy = dy;
          prior.label = actor.label;
        }
      }

      for (const [id, prior] of tracked) {
        if (seen.has(id)) continue;
        tracked.delete(id);
        events.departures.push({ id, label: prior.label, lastDx: prior.dx, lastDy: prior.dy });
      }

      visible.sort((left, right) => left.dCells - right.dCells);
      return events;
    },
    contacts() {
      return visible;
    },
    hostileCount() {
      let count = 0;
      for (const contact of visible) {
        if (contact.relation === "hostile") count += 1;
      }
      return count;
    },
  };
}

/**
 * Radar/prose threat classification on the willAutoAggro key (owner 2026-07-08).
 * An actor that WILL auto-aggro — or is already fighting (aiAttitude hostile) —
 * reads HOSTILE the moment it is in scope, matching the 3D red nameplate. A
 * faction-hostile or merely-aware actor that won't aggro unless attacked reads
 * ALERTED, which the world register narrates as "wary". Everything else is a
 * civilian. Keeps the DEF-4 radar contract: hostiles/alerted rim-clamp, civilians drop.
 */
function relationFor(actor: ServerAuthorityActorState, me: ServerAuthorityActorState | undefined): ContactRelation {
  if (actor.willAutoAggro === true || actor.aiAttitude === "hostile") return "hostile";
  const factionHostile = Boolean(actor.factionId && me?.factionId && actor.factionId !== me.factionId);
  if (factionHostile || actor.aiAttitude === "passive" || actor.aiAttitude === "alerted") return "alerted";
  return "civilian";
}
