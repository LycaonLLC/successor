import { describe, expect, it } from "vitest";
import { movementVectorFromKeys } from "@successor/client/src/slice-core/movementSystem";
import { classifyRadarContact } from "../ui/hud/radar";
import { createDatapadMapProjection } from "../ui/windows/defs/datapadMap";
import { SUCCESSOR_3D_CONFIG } from "../config";
import { IsometricCameraController, worldToScreenViewport } from "./camera";

const CARDINALS = [
  { name: "north", key: "KeyW", world: { x: 0, y: -1 }, screen: { x: 0, y: -1 } },
  { name: "south", key: "KeyS", world: { x: 0, y: 1 }, screen: { x: 0, y: 1 } },
  { name: "east", key: "KeyD", world: { x: 1, y: 0 }, screen: { x: 1, y: 0 } },
  { name: "west", key: "KeyA", world: { x: -1, y: 0 }, screen: { x: -1, y: 0 } },
] as const;

function expectAxis(delta: number, expectedSign: number, label: string): void {
  if (expectedSign === 0) expect(delta, `${label} drift`).toBeCloseTo(0, 5);
  else expect(Math.sign(delta), `${label} sign`).toBe(expectedSign);
}

describe("shared world cardinal contract", () => {
  it("keeps movement, camera, radar, and both map framings on one north-up basis", () => {
    expect(SUCCESSOR_3D_CONFIG.camera.yawDegrees).toBe(0);

    const camera = new IsometricCameraController();
    camera.resize(1_000, 1_000, 100);
    camera.updateFocus(512, 512, 1);
    const cameraOrigin = worldToScreenViewport(camera.camera, 1_000, 1_000, 512, 512);

    const orbital = createDatapadMapProjection(1024, 1024, 800, 800, {
      basis: "north-up",
      fit: "contain",
    });
    const tactical = createDatapadMapProjection(1024, 1024, 800, 800, {
      basis: "north-up",
      fit: "cover",
      zoom: 1.15,
      center: { x: 512, y: 512 },
    });

    for (const cardinal of CARDINALS) {
      expect(movementVectorFromKeys([cardinal.key]), `${cardinal.name} movement`).toEqual(cardinal.world);

      const cameraPoint = worldToScreenViewport(
        camera.camera,
        1_000,
        1_000,
        512 + cardinal.world.x,
        512 + cardinal.world.y,
      );
      expectAxis(cameraPoint.px - cameraOrigin.px, cardinal.screen.x, `${cardinal.name} camera x`);
      expectAxis(cameraPoint.py - cameraOrigin.py, cardinal.screen.y, `${cardinal.name} camera y`);

      const radar = classifyRadarContact(cardinal.world.x, cardinal.world.y, "hostile");
      expect(radar, `${cardinal.name} radar`).toMatchObject({
        xCells: cardinal.screen.x,
        yCells: cardinal.screen.y,
      });

      for (const [mode, projection] of [["orbital", orbital], ["tactical", tactical]] as const) {
        const origin = projection.worldToCanvas(512, 512);
        const point = projection.worldToCanvas(
          512 + cardinal.world.x,
          512 + cardinal.world.y,
        );
        expectAxis(point.x - origin.x, cardinal.screen.x, `${cardinal.name} ${mode} map x`);
        expectAxis(point.y - origin.y, cardinal.screen.y, `${cardinal.name} ${mode} map y`);
      }
    }
  });
});
