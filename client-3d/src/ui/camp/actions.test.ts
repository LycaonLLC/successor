import { afterEach, describe, expect, it } from "vitest";
import type { ServerAuthorityPlacedCampState } from "@successor/client/src/slice-core/gameState";
import {
  armPackUpConfirm,
  campRadialActions,
  campReceiptCopy,
  disarmPackUpConfirm,
  PACK_UP_ARM_WINDOW_MS,
  packUpConfirmArmed,
} from "./actions";

function camp(overrides: Partial<ServerAuthorityPlacedCampState> = {}): ServerAuthorityPlacedCampState {
  return {
    campId: "camp:player:1",
    areaId: "desert",
    cellX: 12,
    cellY: 9,
    isOwner: true,
    renderKind: "scout-camp",
    ...overrides,
  };
}

afterEach(() => {
  disarmPackUpConfirm();
});

describe("campRadialActions", () => {
  it("offers PACK UP inside the camp and names the visible footprint outside it", () => {
    const inside = campRadialActions({ camp: camp(), insideFootprint: true, confirmPackUp: false });
    expect(inside).toEqual([
      { id: "pack-up", label: "PACK UP", enabled: true, note: "Strikes the camp — the kit is spent" },
    ]);

    const outside = campRadialActions({ camp: camp(), insideFootprint: false, confirmPackUp: false });
    expect(outside[0]).toMatchObject({
      id: "pack-up",
      enabled: false,
      note: "OUTSIDE CAMP · ENTER THE 5×5 FOOTPRINT",
    });
  });

  it("leads with the armed abandonment countdown (grace-timer honesty)", () => {
    const rows = campRadialActions({
      camp: camp({ abandonSecondsRemaining: 874 }),
      insideFootprint: false,
      confirmPackUp: false,
    });
    expect(rows[0]).toEqual({
      id: "abandon-countdown",
      label: "COLLAPSES IN 14:34",
      enabled: false,
      note: "ABANDONED · RETURNING RESETS THE CLOCK",
    });
    expect(rows[1]).toMatchObject({ id: "pack-up" });
  });

  it("carries the consumed-on-place truth through the confirm step", () => {
    const confirm = campRadialActions({ camp: camp(), insideFootprint: true, confirmPackUp: true });
    expect(confirm).toEqual([
      {
        id: "confirm-pack-up",
        label: "CONFIRM STRIKE · NOTHING RETURNS",
        enabled: true,
        note: "The kit was spent pitching it",
      },
      { id: "cancel-pack-up", label: "KEEP CAMP", enabled: true, note: null },
    ]);
    // Footprint occupancy still gates the destructive confirm.
    const outside = campRadialActions({ camp: camp(), insideFootprint: false, confirmPackUp: true });
    expect(outside[0]).toMatchObject({
      id: "confirm-pack-up",
      enabled: false,
      note: "OUTSIDE CAMP · ENTER THE 5×5 FOOTPRINT",
    });
  });
});

describe("campReceiptCopy", () => {
  it("speaks denials, announces the strike, and stays quiet on placement", () => {
    expect(campReceiptCopy("PlaceCamp", false, "camp_already_placed")).toBe("DENIED · CAMP ALREADY PLACED");
    expect(campReceiptCopy("PackUpCamp", false, "not_at_camp")).toBe("DENIED · NOT AT CAMP");
    expect(campReceiptCopy("PlaceCamp", false, "structure_footprint_blocked")).toBe(
      "DENIED · CLEAR 5×5 GROUND REQUIRED",
    );
    expect(campReceiptCopy("PackUpCamp", true, null)).toBe("CAMP STRUCK · NOTHING RETURNS");
    // The tent rising IS the placement feedback — no toast.
    expect(campReceiptCopy("PlaceCamp", true, null)).toBeNull();
  });
});

describe("packUpConfirm arm window", () => {
  it("arms per camp, expires after the window, and disarms explicitly", () => {
    expect(packUpConfirmArmed("camp:player:1", 1_000)).toBe(false);
    armPackUpConfirm("camp:player:1", 1_000);
    expect(packUpConfirmArmed("camp:player:1", 1_000 + PACK_UP_ARM_WINDOW_MS)).toBe(true);
    expect(packUpConfirmArmed("camp:other:2", 1_500)).toBe(false);
    // One tick past the window: expired (and self-disarming).
    armPackUpConfirm("camp:player:1", 1_000);
    expect(packUpConfirmArmed("camp:player:1", 1_001 + PACK_UP_ARM_WINDOW_MS)).toBe(false);
    expect(packUpConfirmArmed("camp:player:1", 1_002)).toBe(false);
    armPackUpConfirm("camp:player:1", 2_000);
    disarmPackUpConfirm();
    expect(packUpConfirmArmed("camp:player:1", 2_001)).toBe(false);
  });
});
