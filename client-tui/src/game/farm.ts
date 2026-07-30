/**
 * /farm — the homestead as terminal flows (Agriculture W1-W5 tags 69-79 + 95-96).
 *
 * Verb-on-tile at your feet (§E.1): every action targets the cell you STAND on,
 * point-blank, and resolves the containing owned parcel before the nearest owned
 * parcel in this area. Seeds resolve by species name (like /splice fill);
 * fertilizer resolves by kind. The living loop:
 *   /farm claim -> till -> plant <species> -> water (x days) -> harvest -> plant …
 * Receipts are truth; /farm plot reads the owner farmPlot channel.
 */

import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { resolveItem } from "./exchangeTrade";
import type { CommandLineOut } from "../commands";
import type { GameSession } from "./session";

const SPECIES = ["ashgrain", "sunmelon", "cavemoss"] as const;
// Seed item ids (6_0xx). Resolving a seed by NAME collides with the harvested
// produce ("Ashgrain" produce outranks "Ashgrain Seed" on an exact match), so
// plant resolves the SEED by its numeric id + a seed-band filter.
const SEED_ITEM_ID: Record<string, number> = { ashgrain: 6_001, sunmelon: 6_002, cavemoss: 6_003 };
const FERTILIZER_ITEM_ID: Record<string, number> = { speed: 6_310, quality: 6_311, yield: 6_312 };

interface HereContext {
  x: number;
  y: number;
  areaId: string;
}

type OwnedParcel = PlayState["serverAuthority"]["placedParcels"][number];

function here(state: PlayState): HereContext {
  const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
  return {
    x: Math.floor(me?.x ?? state.player.x),
    y: Math.floor(me?.y ?? state.player.y),
    areaId: me?.areaId ?? state.activeAreaId,
  };
}

function squaredDistanceToParcel(parcel: OwnedParcel, x: number, y: number): number {
  const maxX = parcel.rect.x + parcel.rect.w - 1;
  const maxY = parcel.rect.y + parcel.rect.h - 1;
  const dx = x < parcel.rect.x ? parcel.rect.x - x : x > maxX ? x - maxX : 0;
  const dy = y < parcel.rect.y ? parcel.rect.y - y : y > maxY ? y - maxY : 0;
  return dx * dx + dy * dy;
}

function ownedParcel(state: PlayState, areaId: string, x: number, y: number): OwnedParcel | null {
  let best: OwnedParcel | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const parcel of state.serverAuthority.placedParcels) {
    if (!parcel.isOwner || parcel.areaId !== areaId) continue;
    const distance = squaredDistanceToParcel(parcel, x, y);
    if (distance < bestDistance || (distance === bestDistance && (best === null || parcel.parcelId < best.parcelId))) {
      best = parcel;
      bestDistance = distance;
    }
  }
  return best;
}

export function routeFarm(session: GameSession, args: readonly string[]): CommandLineOut[] {
  const state = session.state;
  const sub = (args[0] ?? "").toLowerCase();
  const usage =
    "Farm: /farm claim [homestead] · till · plant <species> · fertilize <speed|quality|yield> · water · harvest · tend [stop] · plot — verbs act on the tile you STAND on.";
  const { x, y, areaId } = here(state);

  if (sub === "" || sub === "plot") {
    const parcel = ownedParcel(state, areaId, x, y);
    if (!parcel) {
      return [{ register: "system", text: "You hold no land here. Stand where you want your farm and /farm claim." }];
    }
    const plot = state.serverAuthority.farmPlots.find((entry) => entry.parcelId === parcel.parcelId);
    const lines: CommandLineOut[] = [{
      register: "help",
      text: `FARM — ${parcel.name} (${parcel.tier}) · yard ${parcel.farmYard.w}x${parcel.farmYard.h} · tilled ${parcel.tilledTiles} planted ${parcel.plantedTiles}`,
    }];
    for (const tile of plot?.tiles ?? []) {
      const crop = tile.crop;
      const body = crop
        ? `${crop.species} · stage ${crop.stage}/${crop.stageCount} · ${crop.mature ? "READY TO HARVEST" : `${crop.timeToMatureGameDays ?? "?"}d`} · ${crop.health}`
        : tile.tilled ? "tilled soil" : "raw ground";
      const fert = tile.fertilizer && tile.fertilizer !== "none" ? ` · ${tile.fertilizer}` : "";
      lines.push({ register: "survey", text: `  (${tile.cellX},${tile.cellY}) ${body} · moisture ${tile.moisturePct}%${fert}` });
    }
    if ((plot?.tiles.length ?? 0) === 0) lines.push({ register: "system", text: "  Bare yard — /farm till to break ground." });
    return lines;
  }

  if (sub === "claim") {
    // Center the homestead yard on where you STAND so the server's lattice snap
    // (origin rounds to a multiple of the 8-cell quantum; ±4 cells worst case) still
    // leaves your standing cell inside the yard. yard = origin+(1,5) size 14x10, its
    // center is origin+(8,10) => request origin (x-8, y-10). The receipt reports the
    // snapped origin; verbs below act on the tile you stand on (still in the yard).
    const anchor = { x: x - 8, y: y - 10 };
    return [wire(session, `/claim-parcel planet_id=${areaId} area_id=${areaId} x=${anchor.x} y=${anchor.y} tier=homestead`)];
  }

  const parcel = ownedParcel(state, areaId, x, y);
  if (!parcel) return [{ register: "reject", text: "No claim here — /farm claim where you stand first." }];
  const at = `parcel_id=${parcel.parcelId} cell_x=${x} cell_y=${y}`;

  switch (sub) {
    case "till":
      return [wire(session, `/till ${at}`)];
    case "water":
      return [wire(session, `/water ${at}`)];
    case "harvest":
      return [wire(session, `/reap ${at}`)];
    case "clear":
      return [wire(session, `/clear-tile ${at}`)];
    case "tend": {
      const stop = (args[1] ?? "").toLowerCase() === "stop";
      return [wire(session, `/tend parcel_id=${parcel.parcelId} stop=${stop}`)];
    }
    case "plant": {
      const species = (args[1] ?? "").toLowerCase();
      const seedItemId = SEED_ITEM_ID[species];
      if (!seedItemId) {
        return [{ register: "system", text: `Plant what? ${SPECIES.join(" · ")}.` }];
      }
      // Resolve the SEED by id (never the harvested produce of the same species).
      const seed = resolveItem(state, String(seedItemId), (row) => session.isCarried(row.container) && row.itemId === seedItemId);
      if (!seed) return [{ register: "reject", text: `No ${species} seed in your pack — /splice sample ${species} to acquire one.` }];
      return [wire(session, `/plant ${at} container=${seed.row.container} stack_id=${seed.row.stackId} variant_id=${seed.row.variantId}`)];
    }
    case "fertilize":
    case "fertilise": {
      const kind = (args[1] ?? "").toLowerCase();
      const itemId = FERTILIZER_ITEM_ID[kind];
      if (!itemId) return [{ register: "system", text: "Fertilize with: speed · quality · yield." }];
      const fert = resolveItem(state, String(itemId), (row) => session.isCarried(row.container) && row.itemId === itemId);
      if (!fert) return [{ register: "reject", text: `No ${kind} fertilizer in your pack.` }];
      return [wire(session, `/fertilize ${at} container=${fert.row.container} stack_id=${fert.row.stackId} variant_id=${fert.row.variantId}`)];
    }
    default:
      return [{ register: "system", text: usage }];
  }
}

function wire(session: GameSession, line: string): CommandLineOut {
  const result = session.executeVerb(line);
  if (!result) return { register: "reject", text: "Nothing answers — this shard predates the farm." };
  const rejected = result.class === "authority" && result.data.queued === false;
  return { register: rejected ? "reject" : "receipt", text: result.text };
}
