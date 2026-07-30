import { describe, expect, it } from "vitest";
import {
  buildPlacementOffsets,
  claimScreenRect,
  clampScreenRect,
  compareActorId,
  OVERLAY_RIGHT_DOCK_RESERVE_PX,
  overlayViewportBounds,
  placeScreenRect,
  screenRectFromBaseline,
  screenRectFromCenter,
  screenRectHitsAny,
  screenRectsOverlap,
  type ScreenRect,
} from "./screenPlacement";

const bounds: ScreenRect = { left: 0, top: 0, right: 400, bottom: 300 };

describe("screenPlacement", () => {
  it("detects overlap with pad and ignores separated rects", () => {
    const a = screenRectFromCenter(100, 100, 40, 20);
    const b = screenRectFromCenter(130, 100, 40, 20);
    expect(screenRectsOverlap(a, b)).toBe(true);
    expect(screenRectsOverlap(a, b, 0)).toBe(true);
    const c = screenRectFromCenter(200, 100, 40, 20);
    expect(screenRectsOverlap(a, c)).toBe(false);
    expect(screenRectHitsAny(a, [c])).toBe(false);
    expect(screenRectHitsAny(a, [b], 2)).toBe(true);
  });

  it("clamps a rect that hangs off the viewport without resizing it", () => {
    const rect = screenRectFromCenter(-10, 10, 40, 20);
    const clamped = clampScreenRect(rect, bounds);
    expect(clamped.left).toBe(0);
    expect(clamped.right - clamped.left).toBe(40);
    expect(clamped.top).toBe(0);
  });

  it("keeps the preferred seat when nothing is occupied", () => {
    const preferred = screenRectFromBaseline(200, 150, 80, 12, 4);
    const placed = placeScreenRect(preferred, [], bounds, { preferAxis: "y", step: 10 });
    expect(placed.dx).toBe(0);
    expect(placed.dy).toBe(0);
    expect(placed.rect).toEqual(preferred);
  });

  it("shifts a later plate off an earlier claim with bounded deterministic motion", () => {
    const first = screenRectFromBaseline(200, 150, 100, 12, 16);
    const occupied: ScreenRect[] = [];
    claimScreenRect(occupied, first);

    const secondPreferred = screenRectFromBaseline(200, 150, 100, 12, 16);
    const a = placeScreenRect(secondPreferred, occupied, bounds, {
      preferAxis: "y",
      maxShiftX: 64,
      maxShiftY: 88,
      step: 10,
      pad: 3,
    });
    const b = placeScreenRect(secondPreferred, occupied, bounds, {
      preferAxis: "y",
      maxShiftX: 64,
      maxShiftY: 88,
      step: 10,
      pad: 3,
    });

    // Deterministic across calls with the same inputs.
    expect(a).toEqual(b);
    // Must actually move off the claim.
    expect(Math.abs(a.dx) + Math.abs(a.dy)).toBeGreaterThan(0);
    expect(screenRectsOverlap(a.rect, first, 3)).toBe(false);
    // Bounded shift.
    expect(Math.abs(a.dx)).toBeLessThanOrEqual(64);
    expect(Math.abs(a.dy)).toBeLessThanOrEqual(88);
  });

  it("priority order: first claim keeps preferred seat, second yields", () => {
    const localPreferred = screenRectFromCenter(200, 160, 120, 28);
    const enemyPreferred = screenRectFromCenter(200, 160, 120, 28);
    const occupied: ScreenRect[] = [];

    const local = placeScreenRect(localPreferred, occupied, bounds, { preferAxis: "y", step: 10, pad: 3 });
    claimScreenRect(occupied, local.rect);
    const enemy = placeScreenRect(enemyPreferred, occupied, bounds, { preferAxis: "y", step: 10, pad: 3 });

    expect(local.dx).toBe(0);
    expect(local.dy).toBe(0);
    expect(Math.abs(enemy.dx) + Math.abs(enemy.dy)).toBeGreaterThan(0);
    expect(screenRectsOverlap(local.rect, enemy.rect, 3)).toBe(false);
  });

  it("separates stacked floating-text sized boxes so values stay readable", () => {
    const occupied: ScreenRect[] = [];
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      const preferred = screenRectFromCenter(220, 140, 18, 16);
      const placed = placeScreenRect(preferred, occupied, bounds, {
        preferAxis: "yx",
        maxShiftX: 48,
        maxShiftY: 56,
        step: 8,
        pad: 2,
      });
      claimScreenRect(occupied, placed.rect);
      results.push(placed.rect);
    }
    for (let i = 0; i < results.length; i += 1) {
      for (let j = i + 1; j < results.length; j += 1) {
        expect(screenRectsOverlap(results[i]!, results[j]!, 2)).toBe(false);
      }
    }
  });

  it("builds offsets with (0,0) first and stable ordering", () => {
    const offsets = buildPlacementOffsets(20, 20, 10, "y");
    expect(offsets[0]).toEqual([0, 0]);
    const again = buildPlacementOffsets(20, 20, 10, "y");
    expect(offsets).toEqual(again);
    // Upward candidates beat equal-magnitude downward ones under y-bias.
    const upIdx = offsets.findIndex(([dx, dy]) => dx === 0 && dy === -10);
    const downIdx = offsets.findIndex(([dx, dy]) => dx === 0 && dy === 10);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeLessThan(downIdx);
  });

  it("keeps (0,0) when bounds are not divisible by step (64/88 @ 10)", () => {
    const offsets = buildPlacementOffsets(64, 88, 10, "y");
    expect(offsets[0]).toEqual([0, 0]);
    // Exact non-grid bounds are still reachable.
    expect(offsets.some(([dx, dy]) => dx === 64 && dy === 0)).toBe(true);
    expect(offsets.some(([dx, dy]) => dx === -64 && dy === 0)).toBe(true);
    expect(offsets.some(([dx, dy]) => dx === 0 && dy === 88)).toBe(true);
    expect(offsets.some(([dx, dy]) => dx === 0 && dy === -88)).toBe(true);
    // Zero is unique-first: no earlier candidate.
    expect(offsets.filter(([dx, dy]) => dx === 0 && dy === 0)).toHaveLength(1);
  });

  it("preferAxis y sorts vertical ±10 before horizontal ±10", () => {
    const offsets = buildPlacementOffsets(20, 20, 10, "y");
    const up = offsets.findIndex(([dx, dy]) => dx === 0 && dy === -10);
    const down = offsets.findIndex(([dx, dy]) => dx === 0 && dy === 10);
    const right = offsets.findIndex(([dx, dy]) => dx === 10 && dy === 0);
    const left = offsets.findIndex(([dx, dy]) => dx === -10 && dy === 0);
    expect(up).toBeGreaterThanOrEqual(0);
    expect(down).toBeGreaterThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(up).toBeLessThan(right);
    expect(up).toBeLessThan(left);
    expect(down).toBeLessThan(right);
    expect(down).toBeLessThan(left);
  });

  it("never hides a label when the viewport is packed — still returns a clamped seat", () => {
    const occupied: ScreenRect[] = [{ left: 0, top: 0, right: 400, bottom: 300 }];
    const preferred = screenRectFromCenter(200, 150, 40, 20);
    const placed = placeScreenRect(preferred, occupied, bounds, {
      maxShiftX: 20,
      maxShiftY: 20,
      step: 10,
      pad: 2,
    });
    expect(placed.rect.right - placed.rect.left).toBe(40);
    expect(placed.rect.bottom - placed.rect.top).toBe(20);
    expect(placed.rect.left).toBeGreaterThanOrEqual(bounds.left);
    expect(placed.rect.right).toBeLessThanOrEqual(bounds.right);
  });

  it("compareActorId is locale-independent byte order", () => {
    expect(compareActorId("a", "b")).toBeLessThan(0);
    expect(compareActorId("b", "a")).toBeGreaterThan(0);
    expect(compareActorId("npc-10", "npc-10")).toBe(0);
    expect(compareActorId("Actor", "actor")).toBeLessThan(0);
  });

  it("priority place-then-reverse-paint keeps high priority on top layer", () => {
    // Pure layering contract used by nameplates/bubbles/floating texts:
    // place/claim in priority order (index 0 = highest), paint reverse so
    // index 0 is drawn last and wins dense fallback overlaps.
    const placeOrder = ["local", "target", "npc-a", "npc-b"];
    const paintOrder: string[] = [];
    for (let i = placeOrder.length - 1; i >= 0; i -= 1) paintOrder.push(placeOrder[i]!);
    expect(paintOrder).toEqual(["npc-b", "npc-a", "target", "local"]);
    expect(paintOrder[paintOrder.length - 1]).toBe("local");

    const occupied: ScreenRect[] = [];
    const preferred = screenRectFromCenter(200, 160, 100, 24);
    const placed = placeOrder.map(() => {
      const seat = placeScreenRect(preferred, occupied, bounds, {
        preferAxis: "y",
        maxShiftX: 64,
        maxShiftY: 88,
        step: 10,
        pad: 3,
      });
      claimScreenRect(occupied, seat.rect);
      return seat;
    });
    // Highest priority (first place) keeps preferred seat.
    expect(placed[0]!.dx).toBe(0);
    expect(placed[0]!.dy).toBe(0);
    // Later priorities move off it.
    for (let i = 1; i < placed.length; i += 1) {
      expect(Math.abs(placed[i]!.dx) + Math.abs(placed[i]!.dy)).toBeGreaterThan(0);
      expect(screenRectsOverlap(placed[0]!.rect, placed[i]!.rect, 3)).toBe(false);
    }
  });

  it("floating place order is monotonic id descending then original index", () => {
    const items = [
      { id: 2, index: 0 },
      { id: 5, index: 1 },
      { id: 5, index: 2 },
      { id: 1, index: 3 },
    ];
    const order = items.slice().sort((a, b) => b.id - a.id || a.index - b.index);
    expect(order.map((item) => `${item.id}@${item.index}`)).toEqual([
      "5@1",
      "5@2",
      "2@0",
      "1@3",
    ]);
    // Reverse paint => newest (first placed) last/top.
    const paint = order.slice().reverse();
    expect(paint[paint.length - 1]).toEqual({ id: 5, index: 1 });
  });

  it("overlayViewportBounds reserves the right dock and stays valid when tiny", () => {
    const normal = overlayViewportBounds(1280, 720);
    expect(normal.left).toBe(4);
    expect(normal.top).toBe(4);
    expect(normal.bottom).toBe(720 - 4);
    expect(normal.right).toBe(1280 - OVERLAY_RIGHT_DOCK_RESERVE_PX);
    expect(OVERLAY_RIGHT_DOCK_RESERVE_PX).toBe(64);
    // Tiny canvas: non-inverted, at least 1px wide/tall.
    const tiny = overlayViewportBounds(40, 20);
    expect(tiny.right).toBeGreaterThan(tiny.left);
    expect(tiny.bottom).toBeGreaterThan(tiny.top);
    expect(tiny.right - tiny.left).toBeGreaterThanOrEqual(1);
    expect(tiny.bottom - tiny.top).toBeGreaterThanOrEqual(1);
  });

});
