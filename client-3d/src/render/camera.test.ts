import { describe, expect, it } from "vitest";
import { SUCCESSOR_3D_CONFIG } from "../config";
import { IsometricCameraController, worldToScreenViewport } from "./camera";

describe("fixed north-up camera cardinal contract", () => {
  it("locks yaw at zero and projects raw N/W/S/E up/left/down/right", () => {
    expect(SUCCESSOR_3D_CONFIG.camera.yawDegrees).toBe(0);
    const controller = new IsometricCameraController();
    controller.resize(1_000, 1_000, 100);
    controller.updateFocus(0, 0, 1);
    const center = worldToScreenViewport(controller.camera, 1_000, 1_000, 0, 0);
    const expectedDirections = {
      N: { world: { x: 0, y: -1 }, horizontal: 0, vertical: -1 },
      W: { world: { x: -1, y: 0 }, horizontal: -1, vertical: 0 },
      S: { world: { x: 0, y: 1 }, horizontal: 0, vertical: 1 },
      E: { world: { x: 1, y: 0 }, horizontal: 1, vertical: 0 },
    };

    for (const [key, expected] of Object.entries(expectedDirections)) {
      const projected = worldToScreenViewport(controller.camera, 1_000, 1_000, expected.world.x, expected.world.y);
      const horizontal = projected.px - center.px;
      const vertical = projected.py - center.py;
      if (expected.horizontal === 0) expect(horizontal, `${key} horizontal drift`).toBeCloseTo(0, 5);
      else expect(Math.sign(horizontal), `${key} horizontal sign`).toBe(expected.horizontal);
      if (expected.vertical === 0) expect(vertical, `${key} vertical drift`).toBeCloseTo(0, 5);
      else expect(Math.sign(vertical), `${key} vertical sign`).toBe(expected.vertical);
    }
  });
});
