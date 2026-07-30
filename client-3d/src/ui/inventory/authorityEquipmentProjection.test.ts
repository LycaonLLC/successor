import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayState, type PlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  authoritativeWornKey,
  pawnPackEquipmentIds,
  registerPawnPackEquipmentIds,
  resolveAuthoritativeActorEquipmentIds,
} from "../../render/equipmentSlots";
import { buildInventoryViewModel } from "./data";

const EQUIPMENT_IDS = [
  "under_bodysuit",
  "boots_canvas_ankle",
  "top_rigged_tank",
  "hair_afro2",
];

function makeState(): PlayState {
  const slice = {
    schema: "successor.slice-core.v1",
    tick: 1,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 20, height: 12, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 20, height: 12, level: 0 }],
    stateHash: "equipment-projection-test",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "desert",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "left",
      cell: { x: 4, y: 5 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  } as unknown as SliceSnapshot;
  const state = createPlayState(slice, "player");
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.actors.player = {
    id: "player",
    label: "Field Observer",
    role: "player",
    sprite: "adventurer-premium-male",
    areaId: "desert",
    x: 4,
    y: 5,
    direction: "left",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    appearance: { skin: "#96684a", hair: null, hair_mat: "hair_raven", face: null },
    worn: [],
  } as unknown as PlayState["serverAuthority"]["actors"][string];
  return state;
}

function dollFor(state: PlayState) {
  return buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null }).doll;
}

afterEach(() => {
  registerPawnPackEquipmentIds([]);
});

describe("authority worn equipment projections", () => {
  it("moves paper-doll ids initial -> equip -> unequip without local-store resurrection", () => {
    registerPawnPackEquipmentIds(EQUIPMENT_IDS);
    const state = makeState();
    const actor = state.serverAuthority.actors.player!;
    const worn = [
      { item: "under_bodysuit", colors: ["#89cff0"] },
      { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
    ];
    actor.worn = worn;

    expect(dollFor(state).equipmentIds).toEqual(["under_bodysuit", "boots_canvas_ankle"]);

    worn.push({ item: "top_rigged_tank", colors: ["#804040"] });
    expect(dollFor(state).equipmentIds).toEqual([
      "under_bodysuit",
      "boots_canvas_ankle",
      "top_rigged_tank",
    ]);

    worn.splice(2, 1);
    expect(dollFor(state).equipmentIds).toEqual(["under_bodysuit", "boots_canvas_ankle"]);
  });

  it("changes the paper-doll palette when authority mutates colors in place", () => {
    registerPawnPackEquipmentIds(EQUIPMENT_IDS);
    const state = makeState();
    const actor = state.serverAuthority.actors.player!;
    const worn = [{ item: "under_bodysuit", colors: ["#89cff0"] }];
    actor.worn = worn;
    const first = dollFor(state);
    const firstKey = authoritativeWornKey(first.worn);
    expect(firstKey).toBe("under_bodysuit:#89cff0;");

    worn[0]!.colors[0] = "#ff4f9a";
    const changed = dollFor(state);
    expect(changed.equipmentIds).toEqual(["under_bodysuit"]);
    expect(authoritativeWornKey(changed.worn)).toBe("under_bodysuit:#ff4f9a;");
    expect(authoritativeWornKey(changed.worn)).not.toBe(firstKey);
  });

  it("projects saved face and skin into the paper-doll VM", () => {
    registerPawnPackEquipmentIds(EQUIPMENT_IDS);
    const state = makeState();
    const face = {
      eyes: "focused",
      brows: "stern",
      nose: "straight",
      mouth: "neutral",
      eye_color: "#5b402c",
      brow_color: "#201713",
      lip_color: "#6e3e38",
    };
    state.serverAuthority.actors.player!.appearance = {
      skin: "#4a3223",
      hair: "hair_afro2",
      hair_mat: "hair_raven",
      face,
    };

    const doll = dollFor(state);
    expect(doll.appearance?.skin).toBe("#4a3223");
    expect(doll.appearance?.face).toEqual(face);
  });

  it("uses the same authority-only id transitions for the world pawn", () => {
    const availableIds = new Set(EQUIPMENT_IDS);
    const resolve = (ids: readonly string[]) => resolveAuthoritativeActorEquipmentIds({
      availableIds,
      authorityWornIds: ids,
      savedHairId: null,
    });
    expect(resolve(["under_bodysuit", "boots_canvas_ankle"])).toEqual([
      "under_bodysuit",
      "boots_canvas_ankle",
    ]);
    expect(resolve(["under_bodysuit", "boots_canvas_ankle", "top_rigged_tank"])).toEqual([
      "under_bodysuit",
      "boots_canvas_ankle",
      "top_rigged_tank",
    ]);
    expect(resolve(["under_bodysuit", "boots_canvas_ankle"])).toEqual([
      "under_bodysuit",
      "boots_canvas_ankle",
    ]);
  });

  it("warns and skips an unavailable authority id instead of attaching a fake piece", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveAuthoritativeActorEquipmentIds({
        availableIds: pawnPackEquipmentIds(),
        authorityWornIds: ["not-loaded-piece"],
        savedHairId: null,
      })).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("not-loaded-piece"));
    } finally {
      warning.mockRestore();
    }
  });
});
