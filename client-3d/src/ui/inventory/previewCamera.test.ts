import { describe, expect, it } from "vitest";
import { type ActorPreviewCameraBounds, writeActorPreviewCameraBounds } from "./previewCamera";
import { type SlotCameraBounds, writeSlotCameraBoundsForAspect } from "./previewCamera";
import {
  DOLL_CAMERA_HALF_HEIGHT,
  DOLL_CAMERA_HALF_HEIGHT_SWORD_HELD,
  PaperDollCameraFraming,
  resolvePaperDollFramingMode,
} from "./previewCamera";

const AUTHORED_ACTOR_ASPECT = 1.8 / 1.7;

function actorBounds(): ActorPreviewCameraBounds {
  return { left: 0, right: 0, top: 0, bottom: 0 };
}

function slotBounds(): SlotCameraBounds {
  return { left: 0, right: 0, top: 0, bottom: 0 };
}

describe("inventory preview camera bounds", () => {
  it("preserves actor-preview vertical framing and scales horizontal bounds from live aspect", () => {
    const authored = writeActorPreviewCameraBounds(AUTHORED_ACTOR_ASPECT * 1_000, 1_000, actorBounds());
    expect(authored.left).toBeCloseTo(-0.9, 6);
    expect(authored.right).toBeCloseTo(0.9, 6);
    expect(authored.top).toBe(1.35);
    expect(authored.bottom).toBe(-0.35);

    const wide = writeActorPreviewCameraBounds(AUTHORED_ACTOR_ASPECT * 2_000, 1_000, actorBounds());
    expect(wide.top).toBe(1.35);
    expect(wide.bottom).toBe(-0.35);
    expect(wide.left).toBeCloseTo(-1.8, 6);
    expect(wide.right).toBeCloseTo(1.8, 6);

    const narrow = writeActorPreviewCameraBounds(AUTHORED_ACTOR_ASPECT * 500, 1_000, actorBounds());
    expect(narrow.top).toBe(1.35);
    expect(narrow.bottom).toBe(-0.35);
    expect(narrow.left).toBeCloseTo(-0.45, 6);
    expect(narrow.right).toBeCloseTo(0.45, 6);
  });

  it("preserves slot vertical framing and derives horizontal bounds from the scissor aspect", () => {
    const square = writeSlotCameraBoundsForAspect(1, slotBounds());
    expect(square.left).toBeCloseTo(-square.top, 6);
    expect(square.right).toBeCloseTo(square.top, 6);
    expect(square.bottom).toBeCloseTo(-square.top, 6);

    const wide = writeSlotCameraBoundsForAspect(2, slotBounds());
    expect(wide.top).toBe(square.top);
    expect(wide.bottom).toBe(square.bottom);
    expect(wide.left).toBeCloseTo(square.left * 2, 6);
    expect(wide.right).toBeCloseTo(square.right * 2, 6);
  });
});

describe("paper-doll held-sword framing", () => {
  const WELL_ASPECT = 209 / 350;

  it("widens framing ONLY for a held vibrosword; rifle, stowed sword, and unarmed stay default", () => {
    expect(resolvePaperDollFramingMode("melee", true)).toBe("sword-held");
    expect(resolvePaperDollFramingMode("melee", false)).toBe("default");
    expect(resolvePaperDollFramingMode("rifle", true)).toBe("default");
    expect(resolvePaperDollFramingMode("rifle", false)).toBe("default");
    expect(resolvePaperDollFramingMode("none", false)).toBe("default");
    expect(DOLL_CAMERA_HALF_HEIGHT_SWORD_HELD).toBeGreaterThan(DOLL_CAMERA_HALF_HEIGHT);
  });

  it("default-mode bounds are byte-identical to the legacy DOLL_CAMERA_HALF_HEIGHT path", () => {
    const framing = new PaperDollCameraFraming();
    const bounds = slotBounds();
    expect(framing.writeBounds(WELL_ASPECT, bounds)).toBe(true);
    expect(bounds.left).toBe(-DOLL_CAMERA_HALF_HEIGHT * WELL_ASPECT);
    expect(bounds.right).toBe(DOLL_CAMERA_HALF_HEIGHT * WELL_ASPECT);
    expect(bounds.top).toBe(DOLL_CAMERA_HALF_HEIGHT);
    expect(bounds.bottom).toBe(-DOLL_CAMERA_HALF_HEIGHT);
    // Legacy dirty check preserved: unchanged aspect skips the projection write.
    expect(framing.writeBounds(WELL_ASPECT, bounds)).toBe(false);
    // Legacy aspect clamp preserved at both ends.
    expect(framing.writeBounds(0.1, bounds)).toBe(true);
    expect(bounds.left).toBe(-DOLL_CAMERA_HALF_HEIGHT * 0.4);
    expect(framing.writeBounds(9, bounds)).toBe(true);
    expect(bounds.right).toBe(DOLL_CAMERA_HALF_HEIGHT * 2.5);
  });

  it("refreshes projection bounds on mode transitions even at an unchanged aspect", () => {
    const framing = new PaperDollCameraFraming();
    const bounds = slotBounds();
    framing.writeBounds(WELL_ASPECT, bounds);

    // draw: default -> sword-held at the same aspect must rewrite bounds.
    framing.setMode("sword-held");
    expect(framing.writeBounds(WELL_ASPECT, bounds)).toBe(true);
    expect(bounds.top).toBe(DOLL_CAMERA_HALF_HEIGHT_SWORD_HELD);
    expect(bounds.left).toBe(-DOLL_CAMERA_HALF_HEIGHT_SWORD_HELD * WELL_ASPECT);

    // sheath: sword-held -> default restores the exact authored bounds.
    framing.setMode("default");
    expect(framing.writeBounds(WELL_ASPECT, bounds)).toBe(true);
    expect(bounds.top).toBe(DOLL_CAMERA_HALF_HEIGHT);
    expect(bounds.bottom).toBe(-DOLL_CAMERA_HALF_HEIGHT);
    // Settled: no spurious rewrites afterwards.
    expect(framing.writeBounds(WELL_ASPECT, bounds)).toBe(false);

    // Redundant setMode of the current mode never forces a rewrite.
    framing.setMode("default");
    expect(framing.writeBounds(WELL_ASPECT, bounds)).toBe(false);
  });

  it("held-sword half-width covers the worst-case vibrosword tip radius at the well aspect", () => {
    // vibrosword_attach.json: tip +Z 0.782m from guard hub, grip at z=-0.13
    // -> 0.912m tip reach past the hand; hand_r orbits the yaw axis at
    // ~0.34m and melee_idle declination bottoms out near 30° below horizontal.
    const worstTipRadius = 0.34 + 0.912 * Math.cos(Math.PI / 6);
    expect(DOLL_CAMERA_HALF_HEIGHT_SWORD_HELD * WELL_ASPECT).toBeGreaterThan(worstTipRadius);
  });
});
