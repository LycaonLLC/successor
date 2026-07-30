import { describe, expect, it } from "vitest";
import { createPlayState, type SliceSnapshot } from "./gameState";
import { applyAuthoritativeDelta } from "./gameAuthoritySystem";

/**
 * Worn-set wire contract (wardrobe wave 2026-07-08): compact actor snapshots
 * and patches carry `worn` as the trailing tuple slot (after nextSampleTick).
 * Patches with `worn: null/undefined` preserve; arrays replace.
 */

function sliceActor(id: string, x: number, y: number) {
  return {
    id,
    name: id,
    kind: "humanoid",
    x,
    y,
    direction: "right" as const,
    areaId: "open-desert-overworld",
  };
}

function slice(): SliceSnapshot {
  return {
    schema: "test",
    tick: 1,
    tickRateHz: 30,
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 24, height: 18, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 24, height: 18, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [sliceActor("player", 4, 5)],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  } as unknown as SliceSnapshot;
}

const counters = () => ({
  acceptedCommands: 0,
  rejectedCommands: 0,
  shotsFired: 0,
  hits: 0,
  deaths: 0,
});

/** Full compact snapshot tuple with worn at the trailing position. */
function compactActorWithWorn(worn: unknown): unknown[] {
  const tuple: unknown[] = [
    "dressed-operative",          // id
    "Vex",                        // label
    "open-desert-overworld",         // areaId
    10,                           // x
    5,                            // y
    1,                            // direction
    0,                            // lifeState
    1,                            // lifecycleSeq
    [100, 100, 100],              // vitals
    [100, 100, 100],              // maxVitals
    [0, 0, 0, 0, 0, 0, 0],        // bleed
    [],                           // statuses
    null,                         // factionId
    null,                         // socialGroup
    "none",                       // pvpStatus
    0,                            // bodyVanishAtTick
    0,                            // respawnAtTick
    [],                           // professions
    null,                         // activeTitle
    0,                            // skillPointsUsed
    0,                            // skillPointsCap
    0,                            // credits
    null,                         // personalShield
    null,                         // sprite
    "player",                     // role
    null,                         // playerOrganizationId
    null,                         // playerOrganizationTag
    null,                         // weapon
    0,                            // shotSpreadDegreesMilli
    "standing",                   // posture
    0,                            // postureUntilTick
    null,                         // combatQueue
    0,                            // inCombat
    0,                            // cloneSicknessRemainingMs
    0,                            // peaceRequested
    null,                         // aiAttitude
    null,                         // engagementTargetId
    0,                            // lootable
    0,                            // hasLoot
    null,                         // lootRightsActorId
    0,                            // bodyVanishTick
    0,                            // incapRemainingMs
    0,                            // incapCount
    0,                            // incapWindowMs
    "Vex",                        // displayName
    0,                            // linkDead
    { skin: "#96684a", hair: "hair_banded_mohawk", hair_mat: "hair_moss" }, // appearance
    0,                            // nextSampleTick
  ];
  tuple.push(worn);               // worn (trailing)
  return tuple;
}

function patchWith(worn: unknown): unknown[] {
  const patch: unknown[] = ["dressed-operative"];
  // areaId..statuses (10 nullable positional slots)
  for (let i = 0; i < 10; i += 1) patch.push(null);
  // optional tail: pad through displayName (index 44), then the fixed tail —
  // linkDead(45), appearance(46), nextSampleTick(47), worn(48).
  while (patch.length < 45) patch.push(null);
  patch.push(null); // linkDead
  patch.push(null); // appearance
  patch.push(null); // nextSampleTick
  patch.push(worn); // worn
  return patch;
}

function deltaWith(extra: Record<string, unknown>) {
  return {
    schema: "successor.authoritative-shard-delta.v1",
    shardId: "test",
    tick: 22,
    playerActorId: "player",
    actors: {},
    counters: counters(),
    ...extra,
  } as never;
}

describe("gameAuthoritySystem worn wire", () => {
  it("decodes worn from compact full snapshots into authority actor state", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      compactActors: [compactActorWithWorn([
        { item: "top_rigged_tank", colors: ["#804040", "#406090"] },
        { item: "legs_wrapped_workpants", colors: [] },
      ])],
    }));
    expect(state.serverAuthority.actors["dressed-operative"]?.worn).toEqual([
      { item: "top_rigged_tank", colors: ["#804040", "#406090"] },
      { item: "legs_wrapped_workpants", colors: [] },
    ]);
  });

  it("keeps worn across patches that omit it and replaces it when sent", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      compactActors: [compactActorWithWorn([{ item: "top_rigged_tank", colors: [] }])],
    }));

    // Patch WITHOUT worn (null slot) — outfit must survive.
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      tick: 23,
      compactActorPatches: [patchWith(null)],
    }));
    expect(state.serverAuthority.actors["dressed-operative"]?.worn).toEqual([
      { item: "top_rigged_tank", colors: [] },
    ]);

    // Patch WITH worn — replaces the set (including clearing to empty).
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      tick: 24,
      compactActorPatches: [patchWith([{ item: "top_frayed_tunic", colors: ["#6e3a34"] }])],
    }));
    expect(state.serverAuthority.actors["dressed-operative"]?.worn).toEqual([
      { item: "top_frayed_tunic", colors: ["#6e3a34"] },
    ]);
  });

  it("carries worn@48, willAutoAggro@49, and descriptor@50 together at the compact tail (naming-doctrine coexistence)", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const tuple = compactActorWithWorn([{ item: "top_rigged_tank", colors: [] }]); // worn @48
    tuple.push(1);                 // willAutoAggro @49 (namecolor)
    tuple.push("a rogue drifter"); // descriptor    @50 (naming)
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({ compactActors: [tuple] }));
    const actor = state.serverAuthority.actors["dressed-operative"];
    expect(actor?.worn).toEqual([{ item: "top_rigged_tank", colors: [] }]);
    expect(actor?.willAutoAggro).toBe(true);
    expect(actor?.descriptor).toBe("a rogue drifter");
  });

  it("drops malformed worn entries at the wire boundary", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      compactActors: [compactActorWithWorn([
        { item: "top_rigged_tank", colors: ["#804040", "not-a-color"] },
        { item: "", colors: [] },
        { item: 42, colors: [] },
      ])],
    }));
    expect(state.serverAuthority.actors["dressed-operative"]?.worn).toEqual([
      { item: "top_rigged_tank", colors: ["#804040"] },
    ]);
  });

  it("populates wornColors from exact valid worn[].colors on full compact snapshots", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      compactActors: [compactActorWithWorn([
        { item: "under_bodysuit", colors: ["#89cff0"] },
        { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
      ])],
    }));
    const actor = state.serverAuthority.actors["dressed-operative"];
    expect(actor?.worn).toEqual([
      { item: "under_bodysuit", colors: ["#89cff0"] },
      { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
    ]);
    expect(actor?.wornColors).toEqual({
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
    });
  });

  it("preserves wornColors when a compact patch omits worn, and updates equipped keys on worn replace while keeping unequipped keys", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      compactActors: [compactActorWithWorn([
        { item: "under_bodysuit", colors: ["#89cff0"] },
        { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
      ])],
    }));
    // Seed an unequipped durable palette key the compact worn set does not carry.
    state.serverAuthority.actors["dressed-operative"]!.wornColors = {
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
      top_reinforced_crop_vest: ["#ff00ff"],
    };

    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      tick: 23,
      compactActorPatches: [patchWith(null)],
    }));
    expect(state.serverAuthority.actors["dressed-operative"]?.wornColors).toEqual({
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
      top_reinforced_crop_vest: ["#ff00ff"],
    });

    applyAuthoritativeDelta(state, sliceSnapshot, deltaWith({
      tick: 24,
      compactActorPatches: [patchWith([
        { item: "under_bodysuit", colors: ["#112233"] },
        { item: "boots_canvas_ankle", colors: ["#404040", "#909090"] },
      ])],
    }));
    expect(state.serverAuthority.actors["dressed-operative"]?.worn).toEqual([
      { item: "under_bodysuit", colors: ["#112233"] },
      { item: "boots_canvas_ankle", colors: ["#404040", "#909090"] },
    ]);
    expect(state.serverAuthority.actors["dressed-operative"]?.wornColors).toEqual({
      under_bodysuit: ["#112233"],
      boots_canvas_ankle: ["#404040", "#909090"],
      top_reinforced_crop_vest: ["#ff00ff"],
    });
  });

});
