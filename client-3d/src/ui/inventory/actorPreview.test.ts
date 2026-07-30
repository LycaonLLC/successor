import { describe, expect, it } from "vitest";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { PawnPack } from "../../assets/pawnPack";
import type { RenderActor } from "../../render/pawns";
import { registerKnownGearIds, setEquippedGearPlayerId, toggle } from "./equippedGearStore";

// render/pawns.ts builds a canvas-backed shadow texture at module scope; a
// null-context canvas stub satisfies it under the node test environment, so
// the look resolver can be imported without a DOM. Static imports hoist, so
// the module under test MUST come in dynamically after the stub.
(globalThis as { document?: unknown }).document ??= {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
};
const { resolveActorPreviewLook } = await import("./actorPreview");
const {
  defaultRemotePawnEquipmentIds,
  equippedWeaponIdForActor,
  weaponLaneForActor,
} = await import("../../render/pawns");

/**
 * Authority-fidelity contract: player-role previews use actor.worn plus saved hair; NPCs retain deterministic defaults.
 */

function stubPack(): PawnPack {
  return {
    equipment: {
      items: [
        { id: "top_rigged_tank", layer: "Under" },
        { id: "top_frayed_tunic", layer: "Under" },
        { id: "under_tank", layer: "Under" },
        { id: "under_shorts", layer: "Under" },
        { id: "under_bodysuit", layer: "Under" },
        { id: "boots_canvas_ankle", layer: "Under" },
        { id: "armor_harness", layer: "Armor" },
        { id: "helmet_a", layer: "Armor", slot: "cranium" },
        { id: "hair_afro2", layer: "Under", slot: "cranium" },
        { id: "hair_ponytail_long", layer: "Under", slot: "cranium" },
        { id: "armor_reinforcement", layer: "Armor" },
        { id: "armor_gorget", layer: "Armor" },
        { id: "armor_bicep_l", layer: "Armor" },
        { id: "armor_bicep_r", layer: "Armor" },
        { id: "helmet_s3", layer: "Armor", slot: "armor_helmet" },
      ],
    },
  } as unknown as PawnPack;
}

function stubSlice(): SliceSnapshot {
  return {
    combatModel: "roll",
    actors: [],
    camera: { followActor: "p1", zoom: 1 },
    factions: [],
  } as unknown as SliceSnapshot;
}

function stubState(playerActorId: string): PlayState {
  return {
    playerActorId,
    selectedActorId: null,
    serverAuthority: { enabled: true, playerActorId, actors: {} },
  } as unknown as PlayState;
}

function actorWith(appearance: unknown, worn: unknown[] = []): RenderActor {
  return {
    id: "p1",
    label: "Tester",
    role: "player",
    appearance,
    worn,
    weapon: null,
  } as unknown as RenderActor;
}

describe("resolveActorPreviewLook appearance fidelity", () => {
  it("keeps GR0K's authored droid body in target examine without human gear or weapons", () => {
    const look = resolveActorPreviewLook(
      stubPack(),
      "grok",
      {
        id: "grok",
        label: "GR0K",
        role: "scripted_player",
        sprite: "droid-grok-humanoid",
        weapon: { id: 2101 },
      } as unknown as RenderActor,
      stubState("p1"),
      stubSlice(),
    );

    expect(look.specialBodyKey).toBe("droid_grok_humanoid");
    expect(look.equipmentIds).toEqual([]);
    expect(look.weaponLane).toBe("none");
    expect(look.weaponVisible).toBe(false);
    expect(look.signature).toContain("droid_grok_humanoid");
  });

  it("renders the primitive Brawler starter, keeps unarmed model-free, and respects unequip", () => {
    const scrapline = {
      ...actorWith({ skin: "#4a3223", hair: null }),
      weapon: { weaponId: "scrapline-machete", weaponItemId: 3105 },
    } as unknown as RenderActor;
    const scraplineLook = resolveActorPreviewLook(stubPack(), "p1", scrapline, stubState("p1"), stubSlice());
    expect(equippedWeaponIdForActor(scrapline)).toBe("scrapline-machete");
    expect(weaponLaneForActor(scrapline)).toBe("melee");
    expect(scraplineLook).toMatchObject({
      weaponLane: "melee",
      weaponModelKey: "scrapline_machete",
      weaponVisible: true,
    });

    const unarmed = {
      ...actorWith({ skin: "#4a3223", hair: null }),
      weapon: { weaponId: "unarmed", weaponItemId: null },
    } as unknown as RenderActor;
    const unarmedLook = resolveActorPreviewLook(stubPack(), "p1", unarmed, stubState("p1"), stubSlice());
    expect(weaponLaneForActor(unarmed)).toBe("melee");
    expect(unarmedLook).toMatchObject({
      weaponLane: "melee",
      weaponModelKey: null,
      weaponVisible: false,
    });

    const unequippedBrawler = {
      ...actorWith({ skin: "#4a3223", hair: null }),
      professionIds: ["brawler"],
      weapon: null,
    } as unknown as RenderActor;
    expect(equippedWeaponIdForActor(unequippedBrawler)).toBeNull();
    expect(weaponLaneForActor(unequippedBrawler)).toBe("none");

    const legacyBrawler = {
      id: "legacy-brawler",
      role: "skirmisher_brawler",
    } as unknown as RenderActor;
    expect(equippedWeaponIdForActor(legacyBrawler)).toBe("scrapline-machete");
    expect(weaponLaneForActor(legacyBrawler)).toBe("melee");
  });

  it("local player ignores stale gear-store clothing and keeps saved hair", () => {
    setEquippedGearPlayerId("look-test-local");
    registerKnownGearIds([
      { id: "under_tank" },
      { id: "armor_harness" },
      { id: "helmet_a", slot: "cranium" },
    ]);
    toggle("under_tank");
    toggle("armor_harness");

    const look = resolveActorPreviewLook(
      stubPack(),
      "p1",
      actorWith({ skin: "#4A3223", hair: "hair_afro2", hair_mat: "hair_raven" }),
      stubState("p1"),
      stubSlice(),
    );
    expect(look.equipmentIds).toEqual(["hair_afro2"]);
    expect(look.skinTone).toBe("#4a3223"); // normalized wire tone, not clay
    expect(look.hairMaterialId).toBe("hair_raven");
    expect(look.signature).toContain("#4a3223");
    expect(look.signature).toContain("hair_afro2");
  });

  it("keys target examine to saved facial details as well as skin", () => {
    const face = {
      eyes: "focused",
      brows: "stern",
      nose: "straight",
      mouth: "neutral",
      eye_color: "#5b402c",
      brow_color: "#201713",
      lip_color: "#6e3e38",
    };
    const look = resolveActorPreviewLook(
      stubPack(),
      "p1",
      actorWith({ skin: "#4a3223", hair: null, hair_mat: "hair_raven", face }),
      stubState("p1"),
      stubSlice(),
    );
    const changed = resolveActorPreviewLook(
      stubPack(),
      "p1",
      actorWith({ skin: "#4a3223", hair: null, hair_mat: "hair_raven", face: { ...face, mouth: "smile" } }),
      stubState("p1"),
      stubSlice(),
    );

    expect(look.skinTone).toBe("#4a3223");
    expect(look.face).toEqual(face);
    expect(changed.signature).not.toBe(look.signature);
  });

  it("keeps saved appearance hair when inventory headwear is equipped", () => {
    setEquippedGearPlayerId("look-test-cranium");
    registerKnownGearIds([
      { id: "under_tank" },
      { id: "helmet_a", slot: "cranium" },
    ]);
    toggle("under_tank");
    toggle("helmet_a");

    const look = resolveActorPreviewLook(
      stubPack(),
      "p1",
      actorWith({ skin: "#4a3223", hair: "hair_afro2", hair_mat: "hair_raven" }),
      stubState("p1"),
      stubSlice(),
    );
    expect(look.equipmentIds).toEqual(["hair_afro2"]);
  });

  it("falls back to the clay tone only when the wire has no valid appearance", () => {
    setEquippedGearPlayerId("look-test-clay");
    registerKnownGearIds([{ id: "under_tank" }]);

    const missing = resolveActorPreviewLook(stubPack(), "p1", actorWith(undefined), stubState("p1"), stubSlice());
    expect(missing.skinTone).toBe("#cc9978");
    const garbage = resolveActorPreviewLook(stubPack(), "p1", actorWith({ skin: "chartreuse" }), stubState("p1"), stubSlice());
    expect(garbage.skinTone).toBe("#cc9978");
  });

  it("remote actors keep the deterministic remote-default set, not the local gear store", () => {
    setEquippedGearPlayerId("look-test-remote");
    registerKnownGearIds([{ id: "under_tank" }]);
    toggle("under_tank");

    const look = resolveActorPreviewLook(
      stubPack(),
      "npc-7",
      { id: "npc-7", label: "Rogue", appearance: { skin: "#96684a", hair: null, hair_mat: "hair_raven" } } as unknown as RenderActor,
      stubState("p1"),
      stubSlice(),
    );
    // Remote defaults come from defaultRemotePawnEquipmentIds: underlayer +
    // armor plus a deterministic head choice — never the local store set.
    expect(look.equipmentIds).toContain("armor_harness");
    expect(look.equipmentIds).toContain("under_shorts");
    expect(look.skinTone).toBe("#96684a");
    // Signature distinguishes actors by appearance — the portrait cache key.
    const again = resolveActorPreviewLook(
      stubPack(),
      "npc-7",
      { id: "npc-7", label: "Rogue", appearance: { skin: "#6f4a33", hair: null, hair_mat: "hair_raven" } } as unknown as RenderActor,
      stubState("p1"),
      stubSlice(),
    );
    expect(again.signature).not.toBe(look.signature);
  });

  it("remote player-role actors use worn instead of NPC defaults", () => {
    const look = resolveActorPreviewLook(
      stubPack(),
      "remote-player",
      { ...actorWith({ skin: "#96684a", hair: "hair_afro2", hair_mat: "hair_raven" }, [{ item: "under_bodysuit", colors: [] }, { item: "boots_canvas_ankle", colors: [] }]), id: "remote-player" },
      stubState("p1"),
      stubSlice(),
    );
    expect(look.equipmentIds).toEqual(["under_bodysuit", "boots_canvas_ankle", "hair_afro2"]);
  });

  it("renders ANY manifest hair id, not a fixed allow-list (WardrobeCreator new hairs)", () => {
    // hair_ponytail_long is NOT one of the legacy three — the world/remote path
    // must still attach it because resolution is manifest-driven now.
    const ids = defaultRemotePawnEquipmentIds(
      stubPack(),
      "npc-new",
      { id: "npc-new", label: "Rookie", appearance: { skin: "#96684a", hair: "hair_ponytail_long", hair_mat: "hair_silver" } } as unknown as RenderActor,
    );
    expect(ids).toContain("hair_ponytail_long");
  });

  it("a well-formed hair with no GLB in the pack does not attach (falls back to a head choice)", () => {
    const ids = defaultRemotePawnEquipmentIds(
      stubPack(),
      "npc-absent",
      { id: "npc-absent", label: "Ghost", appearance: { skin: "#96684a", hair: "hair_not_in_pack", hair_mat: "hair_silver" } } as unknown as RenderActor,
    );
    expect(ids).not.toContain("hair_not_in_pack");
  });

  it("persisted helmet toggles never mutate or suppress saved appearance hair", () => {
    setEquippedGearPlayerId("look-test-roundtrip");
    registerKnownGearIds([
      { id: "under_tank" },
      { id: "helmet_a", slot: "cranium" },
    ]);
    toggle("under_tank");
    const actor = actorWith({ skin: "#4a3223", hair: "hair_afro2", hair_mat: "hair_raven" });

    const off1 = resolveActorPreviewLook(stubPack(), "p1", actor, stubState("p1"), stubSlice());
    expect(off1.equipmentIds).toContain("hair_afro2");

    toggle("helmet_a");
    const on = resolveActorPreviewLook(stubPack(), "p1", actor, stubState("p1"), stubSlice());
    expect(on.equipmentIds).not.toContain("helmet_a");
    expect(on.equipmentIds).toContain("hair_afro2");

    toggle("helmet_a");
    const off2 = resolveActorPreviewLook(stubPack(), "p1", actor, stubState("p1"), stubSlice());
    expect(off2.equipmentIds).toContain("hair_afro2");
    expect(off2.equipmentIds).not.toContain("helmet_a");
  });

  it("bald characters (appearance.hair === null) attach no hair even with a bare cranium", () => {
    setEquippedGearPlayerId("look-test-bald");
    registerKnownGearIds([{ id: "under_tank" }]);
    toggle("under_tank");
    const look = resolveActorPreviewLook(
      stubPack(),
      "p1",
      actorWith({ skin: "#4a3223", hair: null, hair_mat: "hair_raven" }),
      stubState("p1"),
      stubSlice(),
    );
    expect(look.equipmentIds.some((id) => id.startsWith("hair_"))).toBe(false);
  });
  it("uses the complete authority outfit while ignoring local clothing and keeping saved hair", () => {
    setEquippedGearPlayerId("look-test-authority-worn");
    registerKnownGearIds([{ id: "under_tank" }, { id: "under_shorts" }, { id: "armor_harness" }, { id: "helmet_a", slot: "cranium" }]);
    toggle("under_tank"); toggle("under_shorts"); toggle("armor_harness"); toggle("helmet_a");
    toggle("helmet_a");
    const actor = actorWith(
      { skin: "#4a3223", hair: "hair_afro2", hair_mat: "hair_raven" },
      [{ item: "under_bodysuit", colors: ["#804040"] }, { item: "boots_canvas_ankle", colors: ["#303030"] }],
    );
    const wornLook = resolveActorPreviewLook(stubPack(), "p1", actor, stubState("p1"), stubSlice());
    expect(wornLook.equipmentIds).toEqual(["under_bodysuit", "boots_canvas_ankle", "hair_afro2"]);

    const bareLook = resolveActorPreviewLook(
      stubPack(),
      "p1",
      actorWith({ skin: "#4a3223", hair: "hair_afro2", hair_mat: "hair_raven" }, []),
      stubState("p1"),
      stubSlice(),
    );
    expect(bareLook.equipmentIds).toEqual(["hair_afro2"]);
  });

});
