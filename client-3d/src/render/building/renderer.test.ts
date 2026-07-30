import { OrthographicCamera, Scene } from "three";
import { describe, expect, it } from "vitest";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { BuildingRenderer } from "./renderer";

function stateWithBuilding(building: unknown): PlayState {
  return {
    activeAreaId: "area-a",
    player: { x: 4, y: 5 },
    serverAuthority: {
      building,
      authoritativePlayer: null,
    },
  } as unknown as PlayState;
}

describe("BuildingRenderer authority projection", () => {
  it("reads only successor.authority-building.v1 and maps the camelCase wire", () => {
    const renderer = new BuildingRenderer(new Scene(), new OrthographicCamera());
    renderer.update({} as SliceSnapshot, stateWithBuilding({
      schema: "successor.authority-building.v1",
      tick: 42,
      components: [{
        componentId: "build:parcel-1:1",
        ownerActorId: "actor-1",
        areaId: "area-a",
        parcelId: "parcel-1",
        catalogId: "door_slide_1m",
        kind: "door",
        cellX: 4,
        cellY: 5,
        rotationQuarters: 1,
        palette: { primary: "#112233" },
        doorOpen: true,
      }],
      interiors: [{
        interiorId: "interior-1",
        areaId: "area-a",
        parcelId: "parcel-1",
        cellKeys: ["4,5"],
        roofed: true,
        enclosed: true,
        doorComponentIds: ["build:parcel-1:1"],
      }],
    }), 0);

    expect(renderer.projected()).toMatchObject({
      snapshotTick: 42,
      components: [{
        component_id: "build:parcel-1:1",
        owner_actor_id: "actor-1",
        parcel_id: "parcel-1",
        area_id: "area-a",
        cell_x: 4,
        cell_y: 5,
        rotation_quarters: 1,
        door_open: true,
      }],
      interiors: [{
        interior_id: "interior-1",
        parcel_id: "parcel-1",
        cell_keys: ["4,5"],
        door_component_ids: ["build:parcel-1:1"],
      }],
    });
    renderer.dispose();
  });

  it("resolves a raycast child mesh back to its authority component", () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0.5, 5, 0.5);
    camera.lookAt(0.5, 0, 0.5);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const renderer = new BuildingRenderer(new Scene(), camera);
    renderer.update({} as SliceSnapshot, stateWithBuilding({
      schema: "successor.authority-building.v1",
      tick: 7,
      components: [{
        componentId: "build:parcel-1:floor",
        areaId: "area-a",
        parcelId: "parcel-1",
        catalogId: "floor_1x1",
        kind: "floor",
        cellX: 0,
        cellY: 0,
        rotationQuarters: 0,
        palette: {},
      }],
      interiors: [],
    }), 0);
    renderer.group.updateMatrixWorld(true);

    expect(renderer.pickAtScreenPoint(50, 50, 100, 100)).toMatchObject({
      componentId: "build:parcel-1:floor",
      kind: "floor",
      cellX: 0,
      cellY: 0,
    });
    renderer.dispose();
  });

  it("does not fall back to retired projection keys or schemas", () => {
    const renderer = new BuildingRenderer(new Scene(), new OrthographicCamera());
    renderer.update({} as SliceSnapshot, stateWithBuilding({
      schema: "successor.other.v1",
      tick: 99,
      components: [{ componentId: "stale", areaId: "area-a", catalogId: "wall_1m", kind: "wall" }],
      interiors: [],
    }), 0);

    expect(renderer.projected()).toEqual({ components: [], interiors: [], snapshotTick: 0 });
    renderer.dispose();
  });
});
