import {
  createPlayState,
  type InventoryRow,
  type PlayState,
  type ServerAuthorityActorState,
  type ServerAuthorityResourceStatsState,
  type SliceSnapshot,
} from "../../../client/src/slice-core/gameState";

export const TUI_FIXTURE_PLAYER_ID = "observer";
export const TUI_FIXTURE_CHARACTER_ID = "char-observer";
export const TUI_FIXTURE_AREA_ID = "open-desert";
export const TUI_FIXTURE_LOOT_CONTAINER = "corpse:rogue-1";
export const TUI_FIXTURE_CACHE_CONTAINER = "cache:water-cache-1";

export interface TuiPlayStateFixture {
  slice: SliceSnapshot;
  state: PlayState;
  playerId: string;
  characterId: string;
  lootContainer: string;
  cacheContainer: string;
}

export interface InventoryVisibilityContext {
  /** Stable launch/session identity id, when tests need 3D inventory parity. */
  playerId?: string | null;
  /** Stable character id, when tests need 3D inventory parity. */
  characterId?: string | null;
  /** The one interactable loot/cache container currently opened through a range/rights gate. */
  openLootContainer?: string | null;
}

export type InventoryVisibilityPartition = "local" | "datapad" | "loot" | "hidden";

export function tuiSliceFixture(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 4512,
    tickRateHz: 30,
    combatModel: "roll",
    combatTuning: {
      weaponRangeBands: {
        slugthrower: { pointBlankCells: 6, idealCells: 12, maxCells: 20 },
        vibrosword: { pointBlankCells: 1, idealCells: 2, maxCells: 3 },
      },
    },
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert Theatre", width: 160, height: 160, level: 0 },
    areas: [{ id: TUI_FIXTURE_AREA_ID, name: "Open Desert", kind: "overworld", width: 160, height: 160, level: 0 }],
    stateHash: "tui-fixture",
    camera: { followActor: TUI_FIXTURE_PLAYER_ID, zoom: 1 },
    actors: [
      {
        id: TUI_FIXTURE_PLAYER_ID,
        entity: "actor/player",
        areaId: TUI_FIXTURE_AREA_ID,
        label: "Field Observer",
        role: "player",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "right",
        cell: { x: 40, y: 44 },
        route: [],
        factionId: "settlers",
      },
      {
        id: "rogue-1",
        entity: "actor/rogue-trooper",
        areaId: TUI_FIXTURE_AREA_ID,
        label: "Rogue trooper",
        role: "hostile",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "left",
        cell: { x: 64, y: 36 },
        route: [],
        factionId: "rogues",
        aiAttitude: "hostile",
      },
      {
        id: "civilian-1",
        entity: "actor/civilian",
        areaId: TUI_FIXTURE_AREA_ID,
        label: "Dust farmer",
        role: "civilian",
        sprite: "adventurer-premium-female",
        poseSet: "walk",
        direction: "front",
        cell: { x: 44, y: 47 },
        route: [],
        factionId: "settlers",
        aiAttitude: "passive",
      },
    ],
    props: [
      {
        id: "shelter-1",
        entity: "prop/shelter",
        areaId: TUI_FIXTURE_AREA_ID,
        label: "Tin shelter",
        kind: "structure",
        cell: { x: 38, y: 42 },
        size: { w: 6, h: 4 },
        interactive: false,
        shelter: true,
      },
      {
        id: "water-cache-1",
        entity: "cache:water-cache-1",
        areaId: TUI_FIXTURE_AREA_ID,
        label: "Water cache",
        kind: "storage_chest",
        cell: { x: 41, y: 44 },
        size: { w: 1, h: 1 },
        interactive: true,
      },
      {
        id: "travel-terminal-1",
        entity: "prop/travel-terminal",
        areaId: TUI_FIXTURE_AREA_ID,
        label: "Travel terminal",
        kind: "travel_terminal",
        cell: { x: 52, y: 60 },
        size: { w: 2, h: 2 },
        interactive: true,
      },
    ],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
    factions: [
      { id: "settlers", label: "Settlers", enemies: ["rogues"], allies: [] },
      { id: "rogues", label: "Rogues", enemies: ["settlers"], allies: [] },
    ],
  };
}

export function createTuiPlayStateFixture(): TuiPlayStateFixture {
  const slice = tuiSliceFixture();
  const state = createPlayState(slice, TUI_FIXTURE_PLAYER_ID);
  state.activeAreaId = TUI_FIXTURE_AREA_ID;
  state.player = { x: 40, y: 44 };
  state.facing = "right";
  state.serverAuthority.enabled = true;
  state.serverAuthority.connected = true;
  state.serverAuthority.status = "connected";
  state.serverAuthority.sourceMatchesClient = true;
  state.serverAuthority.playerActorId = TUI_FIXTURE_PLAYER_ID;
  state.serverAuthority.snapshotTick = 4512;
  state.serverAuthority.actors = {
    [TUI_FIXTURE_PLAYER_ID]: actor({
      id: TUI_FIXTURE_PLAYER_ID,
      label: "Field Observer",
      role: "player",
      x: 40,
      y: 44,
      factionId: "settlers",
      weapon: {
        weaponId: "slugthrower",
        weaponItemId: 3101,
        ammoType: "slug_iron",
        loadedRounds: 7,
        magazineSize: 8,
        reloadUntilTick: 0,
        reloadRemainingTicks: 0,
        reloadTotalTicks: 0,
      },
      posture: "standing",
    }),
    "rogue-1": actor({
      id: "rogue-1",
      label: "Rogue trooper",
      role: "hostile",
      x: 64,
      y: 36,
      direction: "left",
      factionId: "rogues",
      aiAttitude: "hostile",
      vitals: { health: 61, action: 44, spirit: 30 },
    }),
    "civilian-1": actor({
      id: "civilian-1",
      label: "Dust farmer",
      role: "civilian",
      x: 44,
      y: 47,
      direction: "front",
      factionId: "settlers",
      aiAttitude: "passive",
    }),
    "corpse-1": actor({
      id: "corpse-1",
      label: "Downed raider",
      role: "hostile",
      x: 41,
      y: 45,
      direction: "front",
      factionId: "rogues",
      aiAttitude: "hostile",
      lifeState: "downed",
      lootable: true,
      hasLoot: true,
      lootRightsActorId: TUI_FIXTURE_PLAYER_ID,
      bodyVanishTick: 4750,
    }),
  };
  state.inventory = inventoryRows();
  state.serverAuthority.surveyResults = [{
    areaId: TUI_FIXTURE_AREA_ID,
    family: "mineral",
    spawnId: "open-desert:mineral:iron-rich-01",
    spawnName: "Dantooine Iron Vein",
    centerX: 72,
    centerY: 31,
    rangeCells: 64,
    stepCells: 16,
    cols: 5,
    rows: 5,
    concentrationMilli: [0, 220, 410, 260, 0, 180, 500, 820, 530, 160, 220, 640, 1000, 610, 240, 80, 300, 520, 350, 90, 0, 120, 250, 130, 0],
    cooldownUntilTick: 5412,
    tick: 4512,
  }];
  state.serverAuthority.resourceSpawns = [{
    spawnId: "open-desert:mineral:iron-rich-01",
    family: "mineral",
    name: "Dantooine Iron Vein",
    variantId: 2001,
    classLabel: "Iron",
    stats: resourceStats({ conductivity: 640, malleability: 520, density: 710, extraction_yield: 880 }),
    activeFromTick: 0,
    activeUntilTick: null,
  }];
  state.weather = [{
    areaId: TUI_FIXTURE_AREA_ID,
    eventType: "heatfall",
    phase: "warning",
    centerX: 104,
    centerY: 24,
    radiusCells: 30,
    intensity: 0.62,
    magnitude: 0.74,
    phaseEndsAtTick: 4860,
    resolvesAtTick: 5400,
    sweepDirRad: Math.PI * 0.25,
  }];
  state.abilityQueue.view = {
    actorId: TUI_FIXTURE_PLAYER_ID,
    nextReadyTick: 4560,
    entries: [{
      id: "queue-1",
      abilityId: "basic_shot",
      iconId: "rifle",
      class: "combat",
      targetActorId: "rogue-1",
      lifecycle: "pending",
      enqueuedAtTick: 4510,
      readyTick: 4560,
    }],
  };
  state.abilityQueue.events = [{
    id: "queue-0",
    lifecycle: "fired",
    tick: 4508,
    abilityId: "basic_shot",
    iconId: "rifle",
    fireSeq: 12,
  }];
  state.serverAuthority.receiptLog.push({
    commandId: 9001,
    accepted: true,
    tick: 4511,
    receivedAtMs: 120,
  });
  state.serverAuthority.eventLog.push({
    id: 7001,
    tick: 4511,
    shooterActorId: TUI_FIXTURE_PLAYER_ID,
    targetActorId: "rogue-1",
    damage: 18,
    zone: "torso",
    previousLifeState: "alive",
    lifeState: "alive",
    targetLifecycleSeq: 1,
    bleedStackCount: 0,
    weaponId: "slugthrower",
    ammoTypeId: "slug_iron",
    receivedAtMs: 125,
    kind: "ranged_roll",
    actionId: "basic_shot",
    hit: true,
    rollMilli: 613,
    toHitMilli: 540,
  });
  state.serverAuthority.propStates = {
    "water-cache-1": { cacheEmptied: false },
    "shelter-door-1": { doorOpen: true },
  };

  return {
    slice,
    state,
    playerId: TUI_FIXTURE_PLAYER_ID,
    characterId: TUI_FIXTURE_CHARACTER_ID,
    lootContainer: TUI_FIXTURE_LOOT_CONTAINER,
    cacheContainer: TUI_FIXTURE_CACHE_CONTAINER,
  };
}

/**
 * Test oracle for 3D inventory parity. This is deliberately test-only: product
 * code should consume the SP1-scoped `/inv` result once Main's fix lands.
 */
export function classifyInventoryRowFor3dParity(
  state: PlayState,
  row: InventoryRow,
  context: InventoryVisibilityContext = {},
): InventoryVisibilityPartition {
  if (isLocalInventoryRowForFixture(state, row, context)) return "local";
  if (row.container === "district-exchange") return "datapad";
  if (row.itemId === 4001 && isLocalInventoryRowForFixture(state, row, context)) return "datapad";
  const openLootContainer = context.openLootContainer?.trim();
  if (openLootContainer && (row.container === openLootContainer || row.container.startsWith(`${openLootContainer}:`) || row.container.startsWith(`${openLootContainer}/`))) {
    return "loot";
  }
  return "hidden";
}

export function visibleInventoryRowsFor3dParity(
  state: PlayState,
  context: InventoryVisibilityContext = {},
): InventoryRow[] {
  return state.inventory.filter((row) => classifyInventoryRowFor3dParity(state, row, context) !== "hidden");
}

function inventoryRows(): InventoryRow[] {
  return [
    row(`${TUI_FIXTURE_PLAYER_ID}:field-pack`, 1001, "Stimpak A", 2),
    row(`${TUI_FIXTURE_CHARACTER_ID}:pouch`, 3001, "Survey Tool", 1),
    row("district-exchange", 4001, "Mission Chit", 1),
    row(TUI_FIXTURE_LOOT_CONTAINER, 1101, "Rogue Carbine", 1),
    row(`${TUI_FIXTURE_CACHE_CONTAINER}:sealed`, 1002, "Field Bandage", 4),
    row("other-player:field-pack", 3104, "Plasma Sword", 1),
  ];
}

function isLocalInventoryRowForFixture(
  state: PlayState,
  row: InventoryRow,
  context: InventoryVisibilityContext,
): boolean {
  const ownerIds = [
    state.serverAuthority.playerActorId,
    state.playerActorId,
    context.playerId,
    context.characterId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const ownerId of ownerIds) {
    if (row.container === ownerId || row.container.startsWith(`${ownerId}:`) || row.container.startsWith(`${ownerId}/`)) return true;
  }
  return false;
}

function row(container: string, itemId: number, item: string, quantity: number, variantId = 0): InventoryRow {
  return {
    container,
    stackId: itemId,
    item,
    itemId,
    variantId,
    quantity,
    reserved: 0,
    available: quantity,
  };
}

function actor(overrides: Partial<ServerAuthorityActorState> & Pick<ServerAuthorityActorState, "id" | "label" | "role" | "x" | "y">): ServerAuthorityActorState {
  return {
    id: overrides.id,
    label: overrides.label,
    role: overrides.role,
    sprite: overrides.sprite ?? "adventurer-premium-male",
    areaId: overrides.areaId ?? TUI_FIXTURE_AREA_ID,
    x: overrides.x,
    y: overrides.y,
    direction: overrides.direction ?? "right",
    lifeState: overrides.lifeState ?? "alive",
    lifecycleSeq: overrides.lifecycleSeq ?? 1,
    vitals: overrides.vitals ?? { health: 96, action: 62, spirit: 100 },
    maxVitals: overrides.maxVitals ?? { health: 100, action: 100, spirit: 100 },
    bleed: overrides.bleed ?? {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    weapon: overrides.weapon ?? null,
    statuses: overrides.statuses ?? [],
    factionId: overrides.factionId,
    aiAttitude: overrides.aiAttitude,
    posture: overrides.posture,
    lootable: overrides.lootable,
    hasLoot: overrides.hasLoot,
    lootRightsActorId: overrides.lootRightsActorId,
    bodyVanishTick: overrides.bodyVanishTick,
    combatQueue: overrides.combatQueue,
  };
}

function resourceStats(overrides: Partial<ServerAuthorityResourceStatsState>): ServerAuthorityResourceStatsState {
  return {
    conductivity: 500,
    malleability: 500,
    shock_resistance: 500,
    thermal_resistance: 500,
    chemical_purity: 500,
    density: 500,
    tensile_strength: 500,
    flexibility: 500,
    potency: 500,
    nutrition: 500,
    stability: 500,
    extraction_yield: 500,
    ...overrides,
  };
}
