import { describe, expect, it } from "vitest";
import { resolvePawnYawTarget, yawForDirection, type PawnYawTargetInput } from "./pawnYaw";
import { equipmentExclusivitySlot, resolveAuthoritativeActorEquipmentIds, resolveLocalActorEquipmentIds } from "./equipmentSlots";

function yawInput(overrides: Partial<PawnYawTargetInput> = {}): PawnYawTargetInput {
  return {
    currentYaw: 0,
    isPlayer: true,
    inputMoving: false,
    renderMoving: false,
    velocityX: 0,
    velocityZ: 0,
    aimYaw: null,
    aimControlsYaw: false,
    engagementYaw: null,
    actorDirection: null,
    ...overrides,
  };
}

describe("resolvePawnYawTarget", () => {
  it("holds local travel yaw during post-release authority correction drift", () => {
    expect(resolvePawnYawTarget(yawInput({
      currentYaw: Math.PI / 4,
      isPlayer: true,
      inputMoving: false,
      renderMoving: true,
      velocityX: -1,
      velocityZ: -1,
    }))).toBeCloseTo(Math.PI / 4);
  });

  it("uses local velocity while movement input is still held", () => {
    expect(resolvePawnYawTarget(yawInput({
      isPlayer: true,
      inputMoving: true,
      renderMoving: true,
      velocityX: -1,
      velocityZ: -1,
    }))).toBeCloseTo(-3 * Math.PI / 4);
  });

  it("lets stopped remote actors fall back to authoritative wire direction", () => {
    expect(resolvePawnYawTarget(yawInput({
      currentYaw: 0,
      isPlayer: false,
      inputMoving: false,
      renderMoving: false,
      actorDirection: "back",
    }))).toBeCloseTo(yawForDirection("back"));
  });

  it("resolved yaw is applied RAW to the render group — no model-forward offset", () => {
    // Regression lock: a +π "forward offset" shipped 2026-07-06 made every
    // pawn run backwards (owner report). yaw 0 IS world front for this rig.
    expect(resolvePawnYawTarget(yawInput({
      isPlayer: true, inputMoving: true, renderMoving: true, velocityX: 0, velocityZ: 1,
    }))).toBeCloseTo(0);
  });
});

describe("equipmentExclusivitySlot", () => {
  it("keeps appearance hair separate from inventory headwear", () => {
    const items = [
      { id: "hair_afro2", slot: "cranium" },
      { id: "helmet_a", slot: "cranium" },
      { id: "hat_warm", slot: "cranium" },
    ];

    expect(equipmentExclusivitySlot(items, "hair_afro2")).toBe("appearance_hair");
    expect(equipmentExclusivitySlot(items, "helmet_a")).toBe("cranium");
    expect(equipmentExclusivitySlot(items, "hat_warm")).toBe("cranium");
  });
});

describe("resolveLocalActorEquipmentIds", () => {
  const availableIds = new Set([
    "top_rigged_tank",
    "top_frayed_tunic",
    "helmet_a",
    "hair_afro2",
  ]);

  it("takes creator clothing from authority and keeps helmets local", () => {
    expect(resolveLocalActorEquipmentIds({
      availableIds,
      localStoreIds: ["top_rigged_tank", "helmet_a", "helmet_a"],
      authorityWornIds: ["top_rigged_tank"],
      savedHairId: "hair_afro2",
    })).toEqual(["helmet_a", "top_rigged_tank", "hair_afro2"]);
  });

  it("removes stale creator clothing when authority worn is empty", () => {
    expect(resolveLocalActorEquipmentIds({
      availableIds,
      localStoreIds: ["top_rigged_tank", "helmet_a"],
      authorityWornIds: [],
      savedHairId: "hair_afro2",
    })).toEqual(["helmet_a", "hair_afro2"]);
  });

  it("makes authority slot swaps replace the prior visible clothing id", () => {
    expect(resolveLocalActorEquipmentIds({
      availableIds,
      localStoreIds: ["top_rigged_tank"],
      authorityWornIds: ["top_frayed_tunic"],
      savedHairId: "hair_afro2",
    })).toEqual(["top_frayed_tunic", "hair_afro2"]);
  });

  it("keeps saved hair independent from local headwear", () => {
    expect(resolveLocalActorEquipmentIds({
      availableIds,
      localStoreIds: ["helmet_a"],
      authorityWornIds: [],
      savedHairId: "hair_afro2",
    })).toEqual(["helmet_a", "hair_afro2"]);
  });

  it("accepts authority-worn legacy wearables (looted helmets/caps) while dropping unknown worn ids", () => {
    expect(resolveLocalActorEquipmentIds({
      availableIds: new Set(["helmet_s2", "hat_field_cap", "top_frayed_tunic"]),
      localStoreIds: [],
      authorityWornIds: ["helmet_s2", "top_frayed_tunic", "hat_field_cap", "not_a_shipped_piece"],
      savedHairId: null,
    })).toEqual(["helmet_s2", "top_frayed_tunic", "hat_field_cap"]);
  });
});

describe("resolveAuthoritativeActorEquipmentIds", () => {
  const availableIds = new Set([
    "under_tank",
    "under_shorts",
    "armor_harness",
    "under_bodysuit",
    "boots_canvas_ankle",
    "hair_afro2",
  ]);

  it("uses only the authoritative Bountyscout-shaped outfit and saved hair", () => {
    expect(resolveAuthoritativeActorEquipmentIds({
      availableIds,
      authorityWornIds: ["under_bodysuit", "boots_canvas_ankle"],
      savedHairId: "hair_afro2",
    })).toEqual(["under_bodysuit", "boots_canvas_ankle", "hair_afro2"]);
  });

  it("keeps an explicitly empty player worn set empty instead of acquiring classic defaults", () => {
    expect(resolveAuthoritativeActorEquipmentIds({
      availableIds,
      authorityWornIds: [],
      savedHairId: "hair_afro2",
    })).toEqual(["hair_afro2"]);
  });
});
