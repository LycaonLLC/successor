import { describe, expect, it } from "vitest";
import {
  clampTurntableZoom,
  nextTurntableZoom,
  TURNTABLE_DRAG_RADIANS_PER_DEVICE_PX,
  TURNTABLE_ZOOM_MAX,
  TURNTABLE_ZOOM_MIN,
  turntableYawFromDrag,
} from "./turntableInteraction";

describe("turntable drag math", () => {
  it("maps device-pixel travel to yaw with the shared feel constant", () => {
    expect(turntableYawFromDrag(0, 0)).toBe(0);
    expect(turntableYawFromDrag(1.5, 200)).toBeCloseTo(1.5 + 200 * TURNTABLE_DRAG_RADIANS_PER_DEVICE_PX, 9);
    // Leftward drag spins the other way, same magnitude.
    expect(turntableYawFromDrag(1.5, -200)).toBeCloseTo(1.5 - 200 * TURNTABLE_DRAG_RADIANS_PER_DEVICE_PX, 9);
  });

  it("supports per-surface feel overrides without touching the shared default", () => {
    expect(turntableYawFromDrag(0, 100, 0.01)).toBeCloseTo(1, 9);
  });
});

describe("turntable zoom math", () => {
  it("zooms in on wheel-up (negative deltaY) and out on wheel-down, symmetric factors", () => {
    const zoomedIn = nextTurntableZoom(1, -100);
    const zoomedOut = nextTurntableZoom(1, 100);
    expect(zoomedIn).toBeGreaterThan(1);
    expect(zoomedOut).toBeLessThan(1);
    // Equal notches are equal FACTORS: in then out returns to start.
    expect(nextTurntableZoom(zoomedIn, 100)).toBeCloseTo(1, 9);
    expect(zoomedIn * zoomedOut).toBeCloseTo(1, 9);
  });

  it("clamps to the shared range at both ends", () => {
    expect(nextTurntableZoom(TURNTABLE_ZOOM_MAX, -5_000)).toBe(TURNTABLE_ZOOM_MAX);
    expect(nextTurntableZoom(TURNTABLE_ZOOM_MIN, 5_000)).toBe(TURNTABLE_ZOOM_MIN);
    expect(clampTurntableZoom(99)).toBe(TURNTABLE_ZOOM_MAX);
    expect(clampTurntableZoom(0)).toBe(TURNTABLE_ZOOM_MIN);
    expect(clampTurntableZoom(1)).toBe(1);
  });

  it("normalizes line-mode wheel deltas so Firefox notches feel like pixel notches", () => {
    // 3 lines ≈ 48px — the two modes should land on the same zoom.
    expect(nextTurntableZoom(1, 3, 1)).toBeCloseTo(nextTurntableZoom(1, 48, 0), 9);
  });

  it("honors custom clamp bounds for constrained surfaces", () => {
    expect(nextTurntableZoom(1, -10_000, 0, 0.8, 1.4)).toBe(1.4);
    expect(nextTurntableZoom(1, 10_000, 0, 0.8, 1.4)).toBe(0.8);
  });
});
