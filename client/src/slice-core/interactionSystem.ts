import { extractorDeviceLabelForFamily } from "./resourceCategories";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityTakeLootItemCommand,
} from "./authorityCommandSystem";
import { formatAbandonCountdown, pointInsideCampInteractionFootprint } from "./campSystem";
import type {
  InteractionOption,
  PlayState,
  ServerAuthorityActorState,
  ServerAuthorityPlacedCampState,
  ServerAuthorityPlacedExtractorState,
  SliceSnapshot,
} from "./gameState";
import { professionTrainerInteractionOptions } from "./professionTrainerSystem";
import type { PropSnapshot } from "./worldTypes";

const interactionRadiusCells = 1.75;
const doorInteractionRadiusCells = 2.2;
/** Mirrors the sim's POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS extractor gate. */
const extractorInteractionRadiusCells = 1.5;
const exchangeInteractionKinds = new Set(["resource_container", "exchange", "container", "trade_terminal"]);

export function cycleInteractionSelection(state: PlayState, direction: 1 | -1): void {
  const count = state.interactions.options.length;
  if (count <= 1) return;
  state.interactions.selectedIndex = (state.interactions.selectedIndex + direction + count) % count;
}

export function interactionOptions(slice: SliceSnapshot, state: PlayState): InteractionOption[] {
  const player = authoritativePlayerActor(state);
  if (!player) return [];
  const options: InteractionOption[] = [];
  for (const prop of slice.props) {
    if (!isExchangeProp(prop) || prop.areaId !== player.areaId) continue;
    const distance = exchangePropFootprintDistanceCells(player, prop);
    if (distance <= interactionRadiusCells) {
      options.push({
        id: `exchange:${prop.id}`,
        kind: "exchange",
        label: prop.label || "District Exchange",
        detail: "Open shared storage",
        targetId: prop.id,
        distanceCells: distance,
      });
    }
  }
  for (const prop of slice.props) {
    if (!isSealedLootCacheProp(prop, state) || prop.areaId !== player.areaId) continue;
    const center = { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 };
    const distance = distanceCells(player, center);
    if (distance <= interactionRadiusCells) {
      options.push({
        id: `loot-cache:${prop.id}`,
        kind: "lootCache",
        label: prop.label || "Supply Cache",
        detail: "Loot sealed cache",
        targetId: prop.id,
        distanceCells: distance,
        ...(prop.container !== undefined ? { container: prop.container } : {}),
        ...(prop.takeOnly !== undefined ? { takeOnly: prop.takeOnly } : {}),
      });
    }
  }
  for (const prop of slice.props) {
    if (!isTravelTerminalProp(prop) || prop.areaId !== player.areaId) continue;
    const center = { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 };
    const distance = distanceCells(player, center);
    if (distance <= 10) {
      options.push({
        id: `travel-terminal:${prop.id}`,
        kind: "travelTerminal",
        label: prop.label || "Travel Terminal",
        detail: "Open planet travel routes",
        targetId: prop.id,
        distanceCells: distance,
      });
    }
  }
  for (const prop of slice.props) {
    if (
      !prop.interactive
      || prop.areaId !== player.areaId
      || (prop.kind !== "bank_terminal" && prop.kind !== "clone_terminal" && prop.kind !== "pa_terminal")
    ) {
      continue;
    }
    const center = {
      x: prop.cell.x + prop.size.w / 2,
      y: prop.cell.y + prop.size.h / 2,
    };
    const playerCenter = { x: player.x + 0.5, y: player.y + 0.5 };
    const distance = distanceCells(playerCenter, center);
    if (distance > interactionRadiusCells) continue;
    if (prop.kind === "pa_terminal") {
      options.push({
        id: `pa-terminal:${prop.id}`,
        kind: "paTerminal",
        label: prop.label || "PA Terminal",
        detail: "Open association registry",
        targetId: prop.id,
        distanceCells: distance,
      });
      continue;
    }
    const bank = prop.kind === "bank_terminal";
    options.push({
      id: `${bank ? "bank" : "clone"}-terminal:${prop.id}`,
      kind: bank ? "bankTerminal" : "cloneTerminal",
      label: prop.label || (bank ? "Bank Terminal" : "Clone Terminal"),
      detail: bank ? "Open personal vault" : "Open cloning services",
      targetId: prop.id,
      distanceCells: distance,
    });
  }
  for (const prop of slice.props) {
    if (!prop.door || prop.areaId !== player.areaId) continue;
    const center = doorWorldCenter(prop);
    const distance = distanceCells(player, center);
    const radius = typeof prop.door.interactRadiusCells === "number" && Number.isFinite(prop.door.interactRadiusCells) ? prop.door.interactRadiusCells : doorInteractionRadiusCells;
    if (distance <= radius) {
      const doorOpen = propDoorOpen(state, prop.id);
      options.push({
        id: `door:${prop.id}`,
        kind: "door",
        label: "SHELTER DOOR",
        detail: doorOpen ? "Close shelter door" : "Open shelter door",
        targetId: prop.id,
        distanceCells: distance,
        doorOpen,
      });
    }
  }
  for (const actor of Object.values(state.serverAuthority.actors)) {
    if (!isLootableCorpse(actor, state) || actor.areaId !== player.areaId) continue;
    const distance = distanceCells(player, actor);
    if (distance <= interactionRadiusCells) {
      const harvestable = isHarvestableCreatureCorpse(actor);
      options.push({
        id: `corpse:${actor.id}`,
        kind: "corpse",
        label: actor.label || actor.id,
        detail: harvestable ? "Harvest hide, meat, and bone" : "Loot remains",
        targetId: actor.id,
        distanceCells: distance,
      });
    }
  }
  for (const extractor of state.serverAuthority.placedExtractors) {
    // Owner-only affordance: every command gate on the sim side requires the
    // owning actor, so foreign extractors stay scenery (no fake verbs).
    if (!extractor.isOwner || extractor.areaId !== player.areaId) continue;
    // Battery-running with an empty hopper has no valid F-verb (crank would
    // reject busy, collect would reject empty) — no option beats a fake one.
    if (extractor.mode === "battery" && extractor.hopperPct === 0) continue;
    const center = { x: extractor.cellX + 0.5, y: extractor.cellY + 0.5 };
    const distance = distanceCells(player, center);
    if (distance <= extractorInteractionRadiusCells) {
      options.push({
        id: `extractor:${extractor.extractorId}`,
        kind: "extractor",
        label: extractorDeviceLabelForFamily(extractor.familyLabel),
        detail: extractorInteractionDetail(extractor),
        targetId: extractor.extractorId,
        distanceCells: distance,
      });
    }
  }
  for (const camp of state.serverAuthority.placedCamps) {
    // Owner-only affordance: pack-up is the only camp verb and it is owner-
    // gated server-side; foreign camps stay scenery (their door still slides —
    // the sim shelters anyone inside, and so does the tent).
    if (!camp.isOwner || camp.areaId !== player.areaId) continue;
    const center = { x: camp.cellX + 0.5, y: camp.cellY + 0.5 };
    const distance = distanceCells(player, center);
    if (pointInsideCampInteractionFootprint(camp, player.areaId, player.x, player.y)) {
      options.push({
        id: `camp:${camp.campId}`,
        kind: "camp",
        label: "Scout Camp",
        detail: campInteractionDetail(camp),
        targetId: camp.campId,
        distanceCells: distance,
      });
    }
  }
  
  for (const prop of slice.props) {
    if (!prop.interactive || prop.areaId !== player.areaId || prop.kind !== "factory") continue;
    const center = { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 };
    const distance = distanceCells(player, center);
    if (distance <= interactionRadiusCells) {
      options.push({
        id: `factory:${prop.id}`,
        kind: "factoryTerminal",
        label: prop.label || "Factory Workbench",
        detail: "Manufacture from a drafted schematic",
        targetId: prop.id,
        distanceCells: distance,
      });
    }
  }
  options.push(...professionTrainerInteractionOptions(slice, state));
  return options.sort((a, b) => {
    const priority = closedDoorPriority(a) - closedDoorPriority(b);
    return priority || a.distanceCells - b.distanceCells || a.id.localeCompare(b.id);
  });
}

function closedDoorPriority(option: InteractionOption): number {
  return option.kind === "door" && option.doorOpen === false ? 0 : 1;
}

function authoritativePlayerActor(state: PlayState): Pick<ServerAuthorityActorState, "id" | "areaId" | "x" | "y"> | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = state.serverAuthority.actors[actorId];
  if (actor) return actor;
  return {
    id: actorId,
    areaId: state.activeAreaId,
    x: state.player.x,
    y: state.player.y,
  };
}

function isExchangeProp(prop: PropSnapshot): boolean {
  const entity = prop.entity.toLowerCase();
  return prop.interactive
    && (exchangeInteractionKinds.has(prop.kind) || entity.startsWith("container:district-exchange") || entity.includes("district-exchange"));
}
function exchangePropFootprintDistanceCells(
  player: Pick<ServerAuthorityActorState, "x" | "y">,
  prop: PropSnapshot,
): number {
  const left = prop.cell.x;
  const right = prop.cell.x + prop.size.w;
  const top = prop.cell.y;
  const bottom = prop.cell.y + prop.size.h;
  const dx = player.x < left ? left - player.x : player.x > right ? player.x - right : 0;
  const dy = player.y < top ? top - player.y : player.y > bottom ? player.y - bottom : 0;
  return Math.hypot(dx, dy);
}

/** Mirrors the authority's exchange-footprint reach before counting exchange inventory. */
export function playerWithinExchangeInteractionRange(slice: SliceSnapshot, state: PlayState): boolean {
  const player = authoritativePlayerActor(state);
  if (!player) return false;
  return slice.props.some((prop) =>
    prop.areaId === player.areaId
    && isExchangeProp(prop)
    && exchangePropFootprintDistanceCells(player, prop) <= interactionRadiusCells,
  );
}


function isSealedLootCacheProp(prop: PropSnapshot, state: PlayState): boolean {
  return prop.interactive && prop.kind === "storage_chest" && !propCacheEmptied(state, prop.id);
}

function isTravelTerminalProp(prop: PropSnapshot): boolean {
  if (!prop.interactive) return false;
  return prop.kind === "travel_terminal";
}

function propCacheEmptied(state: PlayState, propId: string): boolean {
  return state.serverAuthority.propStates?.[propId]?.cacheEmptied === true;
}

function propDoorOpen(state: PlayState, propId: string): boolean {
  return state.serverAuthority.propStates?.[propId]?.doorOpen === true;
}

/** One-line status for the prompt's detail channel — state, not instructions. */
function extractorInteractionDetail(extractor: ServerAuthorityPlacedExtractorState): string {
  const units = Math.max(0, Math.trunc(Number(extractor.collectableUnits) || 0));
  const hopper = units > 0
    ? `${units} unit${units === 1 ? "" : "s"} · ${extractor.hopperPct}%`
    : extractor.hopperPct > 0
      ? `hopper ${extractor.hopperPct}%`
      : null;
  if (extractor.mode === "manual") {
    return hopper ? `Cranking — ${hopper}` : "Cranking — press again to release";
  }
  if (extractor.mode === "battery") {
    return hopper ? `Running on battery · ${hopper}` : "Running on battery";
  }
  if (hopper) return `Stopped · ${hopper}`;
  return "Idle — crank or insert battery";
}

/**
 * Camp detail line — the grace-timer honesty channel: an armed abandonment
 * countdown is the owner's 15-minute rule made visible (hover/status), and
 * a standing camp states its persistence contract.
 */
function campInteractionDetail(camp: ServerAuthorityPlacedCampState | null): string {
  if (!camp) return "Camp struck";
  const armed = camp.abandonSecondsRemaining;
  if (typeof armed === "number") {
    return `Abandoned — collapses in ${formatAbandonCountdown(armed)} · returning resets`;
  }
  return "Sheltered ground — persists while you camp here";
}

function doorWorldCenter(prop: PropSnapshot): { x: number; y: number } {
  const blocker = prop.door?.blocker;
  if (!blocker) return { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 };
  return {
    x: prop.cell.x + (blocker.xMilli + blocker.wMilli / 2) / 1000,
    y: prop.cell.y + (blocker.yMilli + blocker.hMilli / 2) / 1000,
  };
}

function isLootableCorpse(actor: ServerAuthorityActorState, state: PlayState): boolean {
  if (actor.lifeState !== "downed") return false;
  // Authoritative corpse-loot flag (loot-system BE); legacy inventory scan
  // and creature-role detection remain fallbacks only for shards that predate
  // the flag. An explicit false is authoritative, including for creatures.
  if (typeof actor.lootable === "boolean") return actor.lootable;
  if (typeof actor.bodyVanishAtTick === "number" && actor.bodyVanishAtTick <= 0) return false;
  return isHarvestableCreatureCorpse(actor) || corpseInventoryAvailable(state, actor.id) > 0;
}

/**
 * LOOT-window gate (3D double-click/radial): the corpse presents an ITEM
 * surface. Authoritative flags first (hasLoot / lootable), streamed corpse
 * rows as the legacy fallback. Creature resources use HARVEST rather than an
 * item surface, so harvestable bodies are excluded; players (lootable=false)
 * are excluded.
 */
export function corpseHasLootSurface(actor: ServerAuthorityActorState, state: PlayState): boolean {
  if (actor.lifeState !== "downed") return false;
  if (actor.hasLoot === true) return true;
  if (actor.lootable === true && !isHarvestableCreatureCorpse(actor)) return true;
  return corpseInventoryAvailable(state, actor.id) > 0;
}

export function isHarvestableCreatureActor(actor: ServerAuthorityActorState): boolean {
  const role = (actor.role ?? "").toLowerCase();
  return role === "creature";
}

export function isHarvestableCreatureCorpse(actor: ServerAuthorityActorState): boolean {
  const role = (actor.role ?? "").toLowerCase();
  return role === "creature";
}

function corpseInventoryAvailable(state: PlayState, actorId: string): number {
  return state.inventory.reduce((sum, row) => {
    if (!corpseOwnsContainer(actorId, row.container)) return sum;
    return sum + Math.max(0, Number(row.available ?? row.quantity ?? 0));
  }, 0);
}

function corpseOwnsContainer(actorId: string, container: string): boolean {
  if (container === actorId || container.startsWith(`${actorId}:`)) return true;
  const corpse = `corpse:${actorId}`;
  return container === corpse || container.startsWith(`${corpse}:`);
}

/**
 * Take-all for a loot container: one authoritative `TakeLootItem` per streamed
 * stack of the container (and its sub-containers). Shared by the 3D hold-F
 * take-all + LOOT window TAKE ALL button, and the TUI
 * `/lootall`. Returns the number of stacks queued (0 = nothing to take).
 */
export function enqueueTakeAllLootStacks(state: PlayState, slice: SliceSnapshot, container: string): number {
  const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  let queued = 0;
  for (const row of state.inventory) {
    if (row.container !== container && !row.container.startsWith(`${container}:`)) continue;
    const quantity = Math.max(0, Math.trunc(Number(row.available ?? row.quantity ?? 0)));
    if (quantity <= 0) continue;
    if (enqueueAuthorityTakeLootItemCommand(state.authorityCommands, row.container, row.itemId, row.variantId, quantity, issuedAtTick)) {
      queued += 1;
    }
  }
  return queued;
}

function distanceCells(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
