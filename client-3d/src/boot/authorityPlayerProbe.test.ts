import { describe, expect, it } from "vitest";
import type { ServerAuthorityActorState } from "@successor/client/src/slice-core/gameState";
import { authorityPlayerDebugProjection } from "./authorityPlayerProbe";

function authorityActor(patch: Partial<ServerAuthorityActorState> = {}): ServerAuthorityActorState {
  return {
    id: "char_relog",
    label: "WardrobeProof",
    displayName: "WardrobeProof",
    linkDead: false,
    appearance: {
      skin: "#96684a",
      hair: "hair_banded_mohawk",
      hair_mat: "hair_moss",
      face: null,
    },
    worn: [
      { item: "under_bodysuit", colors: ["#89cff0"] },
      { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
    ],
    wornColors: {
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
    },
    role: "player",
    areaId: "open-desert-overworld",
    x: 12.25,
    y: 18.5,
    direction: "front",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 280, action: 160, spirit: 100 },
    maxVitals: { health: 280, action: 160, spirit: 100 },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
    weapon: null,
    skillPointsUsed: 16,
    skillPointsCap: 250,
    ...patch,
  } as ServerAuthorityActorState;
}

describe("authorityPlayerDebugProjection", () => {
  it("exposes exact reconnect worn/profession truth from the authority actor without inventing fields", () => {
    const projected = authorityPlayerDebugProjection(authorityActor(), "char_relog");
    expect(projected).toEqual({
      x: 12.25,
      y: 18.5,
      areaId: "open-desert-overworld",
      displayName: "WardrobeProof",
      linkDead: false,
      appearance: {
        skin: "#96684a",
        hair: "hair_banded_mohawk",
        hair_mat: "hair_moss",
        face: null,
      },
      worn: [
        { item: "under_bodysuit", colors: ["#89cff0"] },
        { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
      ],
      wornColors: {
        under_bodysuit: ["#89cff0"],
        boots_canvas_ankle: ["#303030", "#808080"],
      },
      weapon: null,
      skillPointsUsed: 16,
      skillPointsCap: 250,
    });
  });


  it("derives missing wornColors keys from worn piece colors without inventing other fields", () => {
    const projected = authorityPlayerDebugProjection(authorityActor({
      wornColors: undefined,
      skillPointsUsed: 16,
    }), "char_relog");
    expect(projected?.wornColors).toEqual({
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
    });
    expect(projected?.skillPointsUsed).toBe(16);
    expect(projected?.weapon).toBeNull();
  });

  it("copies an equipped weapon exactly and returns null when the authority actor is missing", () => {
    const weapon = {
      weaponId: "slugthrower",
      weaponItemId: 1003,
      weaponVariantId: 0,
      ammoType: "slug_iron",
      loadedRounds: 12,
      magazineSize: 12,
      reloadUntilTick: 0,
      reloadRemainingTicks: 0,
      reloadTotalTicks: 1,
    };
    expect(authorityPlayerDebugProjection(authorityActor({ weapon }), "char_relog")?.weapon).toEqual(weapon);
    expect(authorityPlayerDebugProjection(undefined, "char_relog")).toBeNull();
  });
});
